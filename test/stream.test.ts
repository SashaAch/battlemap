// The live map (plan 5.3, 5.4, 6.3, 8.6): the event stream, the rights of players on the board, pings, who is
// online, and scenes written a second after their last change. Through real HTTP on a free port of 127.0.0.1
// with the data in a temporary folder; the stream is read with fetch. Every right has a test of the refusal.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import type { TestContext } from "node:test";

import { forwardPatch } from "../client/src/app/api.ts";
import { LiveScene } from "../client/src/app/live.ts";
import { applyPatch, applyToChange, beginChange, finishChange, newHistory, newScene } from "../client/src/board/store.ts";
import type { Patch, Scene } from "../client/src/board/store.ts";
import { startServer } from "../server/app.ts";
import type { RunningServer } from "../server/app.ts";
import { ApiError, ERRORS } from "../server/errors.ts";
import type { ErrorCode } from "../server/errors.ts";
import { Games, MAX_PINGS } from "../server/games.ts";
import { Database } from "../server/db.ts";
import { IDLE_UNLOAD_MS, SAVE_CEILING_MS, SAVE_DELAY_MS, SceneMemory } from "../server/scenes.ts";
import { HEARTBEAT_MS, MAX_STREAMS_PER_USER, Streams } from "../server/stream.ts";
import { SESSION_LIFETIME_MS } from "../server/auth.ts";

// ---- a site in a temporary folder, with open registration so users are quick to make ----

interface Site {
  dir: string;
  server: RunningServer;
  base: string;
  clock: { now: number };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(dir: string, clock: { now: number }, heartbeatMs?: number): Promise<Site> {
  const server = await startServer({ dataDir: dir, host: "127.0.0.1", port: 0, now: () => clock.now, heartbeatMs, log: () => undefined });
  return { dir, server, base: `http://127.0.0.1:${server.port}`, clock };
}

interface Reply {
  status: number;
  body: any;
}

async function call(site: Site, method: string, url: string, cookie?: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { Origin: site.base };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(site.base + url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function assertError(reply: Reply, code: ErrorCode, what = ""): void {
  assert.deepEqual({ status: reply.status, body: reply.body }, { status: ERRORS[code], body: { error: code } }, what);
}

interface Person {
  id: number;
  cookie: string;
  name: string;
}

/** A site with users registered under these logins; the first one is the administrator. */
function siteWith(...logins: string[]): Promise<{ site: Site; users: Record<string, Person> }> {
  return siteOf({}, ...logins);
}

/** The same, with the heartbeat of the streams this often instead of every 25 s. */
async function siteOf(options: { heartbeatMs?: number }, ...logins: string[]): Promise<{ site: Site; users: Record<string, Person> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-stream-"));
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ openRegistration: true }));
  const site = await start(dir, { now: Date.UTC(2026, 0, 1) }, options.heartbeatMs);
  cleanups.push(async () => {
    await site.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const link = site.server.setupLink ?? "";
  const users: Record<string, Person> = {};
  for (const [index, login] of logins.entries()) {
    // Logins are at least 3 characters: "gm" signs up as "gm_".
    const body = { login: login.padEnd(3, "_"), displayName: login.toUpperCase(), password: `${login}-password` };
    const setup = index === 0 ? { setup: link.slice(link.indexOf("#setup=") + 7) } : {};
    const response = await fetch(`${site.base}/api/auth/register`, {
      method: "POST",
      headers: { Origin: site.base, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...setup }),
    });
    assert.equal(response.status, 201, login);
    const cookie = response.headers.get("set-cookie")?.match(/^bm_session=[^;]*/)?.[0];
    assert.ok(cookie);
    users[login] = { id: ((await response.json()) as { id: number }).id, cookie, name: body.displayName };
  }
  return { site, users };
}

/** A game of `gm` with `players` joined by one invite and one scene "Зал", current and visible. */
async function playedGame(site: Site, gm: Person, ...players: Person[]): Promise<{ gameId: number; sceneId: number }> {
  const game = await call(site, "POST", "/api/games", gm.cookie, { title: "Склеп", kind: "gm" });
  const gameId: number = game.body.id;
  const scene = await call(site, "POST", `/api/games/${gameId}/scenes`, gm.cookie, { name: "Зал" });
  const sceneId: number = scene.body.id;
  assert.equal((await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, gm.cookie, { visible: true })).status, 200);
  const invite = await call(site, "POST", `/api/games/${gameId}/invites`, gm.cookie, { maxUses: 10, days: 7 });
  for (const player of players) assert.equal((await call(site, "POST", `/api/join/${invite.body.code}`, player.cookie)).status, 200);
  return { gameId, sceneId };
}

const patch = (site: Site, gameId: number, sceneId: number, person: Person, change: unknown): Promise<Reply> =>
  call(site, "POST", `/api/games/${gameId}/scenes/${sceneId}/patch`, person.cookie, { patch: change });

const scene = async (site: Site, gameId: number, sceneId: number, person: Person): Promise<{ version: number; scene: any }> =>
  (await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, person.cookie)).body;

function token(name: string, side: string, x = 0, y = 0) {
  return { name, side, size: "medium", x, y, hidden: false, vision: null, character: null };
}

/** The scene row in the database file, read beside the running server. */
function stored(site: Site, sceneId: number): { version: number; state: Scene } {
  const db = new DatabaseSync(path.join(site.dir, "battlemap.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT version, state_json FROM scenes WHERE id = ?").get(sceneId);
    assert.ok(row, `scene ${sceneId} is in the database`);
    return { version: Number(row.version), state: JSON.parse(String(row.state_json)) };
  } finally {
    db.close();
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, up to `ms`. */
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await wait(20);
  }
}

// ---- reading an event stream ----

interface StreamEvent {
  event: string;
  data: any;
}

const EVENT_TIMEOUT_MS = 3000;

/** An open event stream: the events that came in order, the status of the answer, and whether it ended. */
class Reader {
  readonly status: number;
  readonly body: any;
  /** Every event that came, in order; `next` takes them out. */
  readonly events: StreamEvent[] = [];
  ended = false;
  readonly #abort: AbortController;

  private constructor(status: number, body: any, abort: AbortController) {
    this.status = status;
    this.body = body;
    this.#abort = abort;
  }

  /** Opens `api/stream?<query>`; an answer other than 200 is read as JSON into `body`. */
  static async open(site: Site, query: string, cookie?: string): Promise<Reader> {
    const abort = new AbortController();
    const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
    const response = await fetch(`${site.base}/api/stream?${query}`, { headers, signal: abort.signal });
    if (response.status !== 200) {
      const text = await response.text();
      return new Reader(response.status, text ? JSON.parse(text) : undefined, abort);
    }
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = new Reader(200, undefined, abort);
    cleanups.push(async () => reader.close());
    void reader.#read(response.body);
    return reader;
  }

  static async of(site: Site, gameId: number, person: Person): Promise<Reader> {
    const reader = await Reader.open(site, `game=${gameId}`, person.cookie);
    assert.equal(reader.status, 200);
    return reader;
  }

  async #read(body: ReadableStream<Uint8Array> | null): Promise<void> {
    assert.ok(body);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = block.split("\n").filter((line) => !line.startsWith(":"));
          const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
          if (name !== undefined && data !== undefined) this.events.push({ event: name, data: JSON.parse(data) });
        }
      }
    } catch {
      // Aborted by close().
    }
    this.ended = true;
  }

  /** Takes out the first event named `name`, waiting for it; the events before it stay. */
  async next(name: string): Promise<any> {
    await until(() => this.events.some((entry) => entry.event === name), EVENT_TIMEOUT_MS, `event ${name}`);
    const index = this.events.findIndex((entry) => entry.event === name);
    return this.events.splice(index, 1)[0].data;
  }

  /** No event named `name` comes within `ms`. */
  async none(name: string, ms = 200): Promise<void> {
    await wait(ms);
    assert.deepEqual(
      this.events.filter((entry) => entry.event === name),
      [],
      `no ${name} expected`,
    );
  }

  async closedByServer(): Promise<void> {
    await until(() => this.ended, EVENT_TIMEOUT_MS, "the stream ends");
  }

  close(): void {
    this.#abort.abort();
  }
}

// ---- tests ----

describe("opening a stream", () => {
  test("the first event is the snapshot of the current scene; then who is online", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    await patch(site, gameId, sceneId, users.gm, [["cells", "0,0", "floor"]]);
    const gm = await Reader.of(site, gameId, users.gm);
    await until(() => gm.events.length >= 2, EVENT_TIMEOUT_MS, "two events");
    assert.deepEqual(
      gm.events.splice(0).map((entry) => [entry.event, entry.data.online]),
      [
        ["scene.snapshot", undefined],
        ["presence", [users.gm.id]],
      ],
    );
    const pat = await Reader.of(site, gameId, users.pat);
    await until(() => pat.events.length >= 2, EVENT_TIMEOUT_MS, "two events");
    assert.deepEqual(
      pat.events.map((entry) => entry.event),
      ["scene.snapshot", "presence"],
    );
    const snapshot = pat.events[0].data;
    assert.deepEqual([snapshot.editor, snapshot.scene.id, snapshot.scene.version, snapshot.scene.scene.cells], [false, sceneId, 1, { "0,0": "floor" }]);
    assert.deepEqual(pat.events[1].data, { online: [users.gm.id, users.pat.id].sort((a, b) => a - b) });
    assert.deepEqual(await gm.next("presence"), { online: [users.gm.id, users.pat.id].sort((a, b) => a - b) }, "the others learn it too");

    pat.close();
    assert.deepEqual(await gm.next("presence"), { online: [users.gm.id] }, "and when the player goes");
  });

  test("the master's snapshot says editor and has the current scene", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId, sceneId } = await playedGame(site, users.gm);
    const gm = await Reader.of(site, gameId, users.gm);
    const snapshot = await gm.next("scene.snapshot");
    assert.deepEqual([snapshot.editor, snapshot.scene.id, snapshot.scene.name, snapshot.scene.active], [true, sceneId, "Зал", true]);
  });

  test("someone who is not a member cannot open the stream of a game (404), without a session 401", async () => {
    const { site, users } = await siteWith("admin", "gm", "eve");
    const { gameId } = await playedGame(site, users.gm);
    const eve = await Reader.open(site, `game=${gameId}`, users.eve.cookie);
    assertError({ status: eve.status, body: eve.body }, "game.notFound");
    const admin = await Reader.open(site, `game=${gameId}`, users.admin.cookie);
    assertError({ status: admin.status, body: admin.body }, "game.notFound", "an administrator is no member either");
    const missing = await Reader.open(site, `game=${gameId + 100}`, users.gm.cookie);
    assertError({ status: missing.status, body: missing.body }, "game.notFound", "a game that does not exist looks the same");
    const nobody = await Reader.open(site, `game=${gameId}`);
    assertError({ status: nobody.status, body: nobody.body }, "auth.required");
    const forged = await Reader.open(site, `game=${gameId}`, "bm_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assertError({ status: forged.status, body: forged.body }, "auth.required", "a made-up session");
  });

  test("a stream without a game or with a malformed id is an unknown request; only GET opens one", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId } = await playedGame(site, users.gm);
    for (const query of ["", "game=", "game=0", "game=01", "game=abc", "game=1234567890123456", `id=${gameId}`]) {
      const reader = await Reader.open(site, query, users.gm.cookie);
      assertError({ status: reader.status, body: reader.body }, "request.notFound", query);
    }
    assertError(await call(site, "POST", `/api/stream?game=${gameId}`, users.gm.cookie), "request.notFound");
  });

  test("a user who must replace a reset password cannot open a stream", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId } = await playedGame(site, users.gm);
    const reset = await call(site, "POST", "/api/admin/users", users.admin.cookie, { action: "resetPassword", id: users.gm.id });
    const login = await fetch(`${site.base}/api/auth/login`, {
      method: "POST",
      headers: { Origin: site.base, "Content-Type": "application/json" },
      body: JSON.stringify({ login: "gm_", password: reset.body.password }),
    });
    const cookie = login.headers.get("set-cookie")?.match(/^bm_session=[^;]*/)?.[0];
    const reader = await Reader.open(site, `game=${gameId}`, cookie);
    assertError({ status: reader.status, body: reader.body }, "auth.mustChangePassword");
  });

  test(`a user has at most ${MAX_STREAMS_PER_USER} open streams: the next one gets 429, and one closing frees a place`, async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId } = await playedGame(site, users.gm);
    const open: Reader[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) open.push(await Reader.of(site, gameId, users.gm));
    const over = await Reader.open(site, `game=${gameId}`, users.gm.cookie);
    assertError({ status: over.status, body: over.body }, "stream.tooMany");
    const presences = (): number => open[1].events.filter((entry) => entry.event === "presence").length;
    const before = presences();
    open[0].close();
    await until(() => presences() > before, EVENT_TIMEOUT_MS, "the closed stream is gone");
    assert.equal((await Reader.open(site, `game=${gameId}`, users.gm.cookie)).status, 200);
  });

  test("after a reconnection the stream starts with a fresh snapshot", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    const first = await Reader.of(site, gameId, users.pat);
    assert.equal((await first.next("scene.snapshot")).scene.version, 0);
    first.close();
    await patch(site, gameId, sceneId, users.gm, [["cells", "0,0", "floor"]]);
    await patch(site, gameId, sceneId, users.gm, [["cells", "1,0", "grass"]]);
    const again = await Reader.of(site, gameId, users.pat);
    await until(() => again.events.length > 0, EVENT_TIMEOUT_MS, "an event");
    assert.equal(again.events[0].event, "scene.snapshot");
    const snapshot = again.events[0].data;
    assert.deepEqual([snapshot.scene.version, snapshot.scene.scene.cells], [2, { "0,0": "floor", "1,0": "grass" }]);
  });
});

describe("changes in order", () => {
  test("a change of the master comes to the player, and back to the master, with the new version", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    const gm = await Reader.of(site, gameId, users.gm);
    const pat = await Reader.of(site, gameId, users.pat);
    const change = [["cells", "0,0", "floor"], ["edges", "h:0,0", "wall"]];
    assert.deepEqual((await patch(site, gameId, sceneId, users.gm, change)).body, { version: 1 });
    for (const reader of [pat, gm]) assert.deepEqual(await reader.next("scene.patch"), { sceneId, version: 1, patch: change });
    await patch(site, gameId, sceneId, users.gm, [["cells", "0,0", null]]);
    assert.equal((await pat.next("scene.patch")).version, 2);
  });

  test("a change of a scene the player does not see never reaches the player's stream", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const hidden = (await call(site, "POST", `/api/games/${gameId}/scenes`, users.gm.cookie, { name: "Тайник" })).body.id;
    const gm = await Reader.of(site, gameId, users.gm);
    const pat = await Reader.of(site, gameId, users.pat);
    await gm.next("scene.snapshot");
    await patch(site, gameId, hidden, users.gm, [["tokens", "t1", token("Засада", "enemies")]]);
    assert.equal((await gm.next("scene.patch")).sceneId, hidden, "the master gets every scene");
    await pat.none("scene.patch");
  });

  test("changes of two tabs of the master come back to both in one order", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId, sceneId } = await playedGame(site, users.gm);
    const tabs = [await Reader.of(site, gameId, users.gm), await Reader.of(site, gameId, users.gm)];
    const changes = Array.from({ length: 10 }, (_, i) => [["cells", "0,0", i % 2 === 0 ? "floor" : "grass"]]);
    await Promise.all(changes.map((change) => patch(site, gameId, sceneId, users.gm, change)));
    const seen = await Promise.all(tabs.map(async (tab) => Promise.all(changes.map(() => tab.next("scene.patch")))));
    assert.deepEqual(seen[0], seen[1]);
    assert.deepEqual(
      seen[0].map((event) => event.version),
      changes.map((_, i) => i + 1),
    );
    const last = seen[0][seen[0].length - 1].patch[0][2];
    assert.equal((await scene(site, gameId, sceneId, users.gm)).scene.cells["0,0"], last, "the scene is the last change");
  });
});

describe("rights of a player on the board (plan 5.4, R6)", () => {
  /** A game with the tokens of the player's side, of the enemies and an ally, and the player's stream. */
  async function board() {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    const tokens = [
      ["tokens", "hero", token("Герой", "players", 0, 0)],
      ["tokens", "gob", token("Гоблин", "enemies", 3, 0)],
      ["tokens", "ally", token("Страж", "allies", 5, 0)],
    ];
    assert.equal((await patch(site, gameId, sceneId, users.gm, tokens)).status, 200);
    const gm = await Reader.of(site, gameId, users.gm);
    await gm.next("scene.snapshot");
    return { site, users, gameId, sceneId, gm };
  }

  test("a player moves a token of the side «players»: 204, and everyone gets the move", async () => {
    const { site, users, gameId, sceneId, gm } = await board();
    const move = [["tokens", "hero", token("Герой", "players", 2, 1)]];
    const reply = await patch(site, gameId, sceneId, users.pat, move);
    assert.deepEqual([reply.status, reply.body], [204, undefined]);
    assert.deepEqual(await gm.next("scene.patch"), { sceneId, version: 2, patch: move });
    assert.deepEqual((await scene(site, gameId, sceneId, users.pat)).scene.tokens.hero, move[0][2]);
  });

  test("a player moving an enemy token gets 403 and the scene does not change", async () => {
    const { site, users, gameId, sceneId, gm } = await board();
    assertError(await patch(site, gameId, sceneId, users.pat, [["tokens", "gob", token("Гоблин", "enemies", 4, 0)]]), "auth.forbidden");
    assertError(await patch(site, gameId, sceneId, users.pat, [["tokens", "ally", token("Страж", "allies", 6, 0)]]), "auth.forbidden", "an ally");
    assert.equal((await scene(site, gameId, sceneId, users.gm)).version, 1);
    await gm.none("scene.patch");
  });

  test("a player renaming a token of their side gets 403", async () => {
    const { site, users, gameId, sceneId } = await board();
    assertError(await patch(site, gameId, sceneId, users.pat, [["tokens", "hero", token("Злодей", "players", 0, 0)]]), "auth.forbidden");
    assertError(await patch(site, gameId, sceneId, users.pat, [["tokens", "hero", token("Злодей", "players", 1, 0)]]), "auth.forbidden", "with a move");
    assert.equal((await scene(site, gameId, sceneId, users.gm)).scene.tokens.hero.name, "Герой");
  });

  test("a player putting a new token gets 403", async () => {
    const { site, users, gameId, sceneId } = await board();
    assertError(await patch(site, gameId, sceneId, users.pat, [["tokens", "new1", token("Ещё", "players", 1, 1)]]), "auth.forbidden");
    assert.equal(Object.hasOwn((await scene(site, gameId, sceneId, users.gm)).scene.tokens, "new1"), false);
  });

  test("any other change of a player is 403, a mixed change too, and the scene stays as it was", async () => {
    const { site, users, gameId, sceneId, gm } = await board();
    const before = await scene(site, gameId, sceneId, users.gm);
    const move = ["tokens", "hero", token("Герой", "players", 1, 1)];
    const refused: [string, unknown][] = [
      ["delete", [["tokens", "hero", null]]],
      ["side", [["tokens", "hero", token("Герой", "enemies", 0, 0)]]],
      ["size", [["tokens", "hero", { ...token("Герой", "players"), size: "large" }]]],
      ["hidden", [["tokens", "hero", { ...token("Герой", "players"), hidden: true }]]],
      ["vision", [["tokens", "hero", { ...token("Герой", "players"), vision: 60 }]]],
      ["cell", [["cells", "0,0", "floor"]]],
      ["edge", [["edges", "h:0,0", "wall"]]],
      ["object", [["objects", "o1", { type: "chest", x: 0, y: 0 }]]],
      ["mark", [["marks", "m1", { color: "#c0392b", pts: [[0, 0]] }]]],
      ["setting", [["settings", "diagonal", "5-10-5"]]],
      ["mixed", [move, ["cells", "0,0", "floor"]]],
      ["mixed with an enemy", [move, ["tokens", "gob", token("Гоблин", "enemies", 9, 9)]]],
    ];
    for (const [what, change] of refused) assertError(await patch(site, gameId, sceneId, users.pat, change), "auth.forbidden", what);
    assert.deepEqual(await scene(site, gameId, sceneId, users.gm), before);
    await gm.none("scene.patch");
  });

  test("a malformed change of a player is 400, as for the master", async () => {
    const { site, users, gameId, sceneId } = await board();
    assertError(await patch(site, gameId, sceneId, users.pat, [["tokens", "hero", { name: "Герой" }]]), "scene.patch");
    assertError(await patch(site, gameId, sceneId, users.pat, "tokens"), "scene.patch");
  });

  test("an empty change is 400 for the player and the master: the version stays and nobody gets an event", async () => {
    const { site, users, gameId, sceneId, gm } = await board();
    const pat = await Reader.of(site, gameId, users.pat);
    await pat.next("scene.snapshot");
    assertError(await patch(site, gameId, sceneId, users.pat, []), "scene.patch", "the player");
    assertError(await patch(site, gameId, sceneId, users.gm, []), "scene.patch", "the master");
    assert.equal((await scene(site, gameId, sceneId, users.gm)).version, 1);
    await gm.none("scene.patch");
    await pat.none("scene.patch", 0);
  });

  test("__proto__ and constructor in a player's change are refused: the scene and the objects stay as they were", async () => {
    const { site, users, gameId, sceneId, gm } = await board();
    const before = await scene(site, gameId, sceneId, users.gm);
    const hero = JSON.stringify(token("Герой", "players", 1, 1)).slice(1, -1);
    // Written as JSON text: in a JS object literal `__proto__` would set the prototype instead of a key.
    // A key the scene does not have is not a move (403); a field a token does not have is not a token (400).
    const refused: [string, string, ErrorCode][] = [
      ["the key __proto__", `[["tokens","__proto__",{${hero}}]]`, "scene.patch"],
      ["the key constructor", `[["tokens","constructor",{${hero}}]]`, "auth.forbidden"],
      ["a field __proto__", `[["tokens","hero",{${hero},"__proto__":{"side":"enemies"}}]]`, "scene.patch"],
      ["a field constructor", `[["tokens","hero",{${hero},"constructor":{"prototype":{"polluted":true}}}]]`, "scene.patch"],
    ];
    for (const [what, change, code] of refused) {
      const response = await fetch(`${site.base}/api/games/${gameId}/scenes/${sceneId}/patch`, {
        method: "POST",
        headers: { Origin: site.base, "Content-Type": "application/json", Cookie: users.pat.cookie },
        body: `{"patch":${change}}`,
      });
      assertError({ status: response.status, body: await response.json() }, code, what);
    }
    assert.deepEqual(await scene(site, gameId, sceneId, users.gm), before);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).side, undefined);
    await gm.none("scene.patch");
  });

  test("a player changes only the current visible scene: a hidden one, or the current one hidden, is 404", async () => {
    const { site, users, gameId, sceneId } = await board();
    const other = (await call(site, "POST", `/api/games/${gameId}/scenes`, users.gm.cookie, { name: "Лес" })).body.id;
    await patch(site, gameId, other, users.gm, [["tokens", "hero", token("Герой", "players", 0, 0)]]);
    await call(site, "PUT", `/api/games/${gameId}/scenes/${other}`, users.gm.cookie, { visible: true });
    const move = [["tokens", "hero", token("Герой", "players", 1, 0)]];
    assertError(await patch(site, gameId, other, users.pat, move), "scene.notFound", "visible, not current");
    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie, { visible: false });
    assertError(await patch(site, gameId, sceneId, users.pat, move), "scene.notFound", "current, hidden");
  });

  test("the owner of a personal campaign with a master has a player's rights on the board", async () => {
    const { site, users } = await siteWith("admin", "anna", "gm");
    const gameId = (await call(site, "POST", "/api/games", users.anna.cookie, { title: "Моя", kind: "personal" })).body.id;
    const sceneId = (await call(site, "POST", `/api/games/${gameId}/scenes`, users.anna.cookie, { name: "Дом" })).body.id;
    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.anna.cookie, { visible: true });
    await patch(site, gameId, sceneId, users.anna, [["tokens", "me", token("Анна", "players")]]);
    const code = (await call(site, "POST", `/api/games/${gameId}/invites`, users.anna.cookie, { maxUses: 1, days: 1 })).body.code;
    await call(site, "POST", `/api/join/${code}`, users.gm.cookie);
    await call(site, "POST", `/api/games/${gameId}/master`, users.anna.cookie, { userId: users.gm.id });
    assertError(await patch(site, gameId, sceneId, users.anna, [["cells", "0,0", "floor"]]), "auth.forbidden");
    assert.equal((await patch(site, gameId, sceneId, users.anna, [["tokens", "me", token("Анна", "players", 1, 0)]])).status, 204);
  });
});

describe("what a player sees changes live", () => {
  test("a hidden current scene is «no scene» to the player; showing it sends scene.switch and the snapshot", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie, { visible: false });
    await patch(site, gameId, sceneId, users.gm, [["cells", "0,0", "floor"]]);
    const pat = await Reader.of(site, gameId, users.pat);
    assert.deepEqual(await pat.next("scene.snapshot"), { editor: false, scene: null });
    await pat.none("scene.patch");

    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie, { visible: true });
    assert.deepEqual(await pat.next("scene.switch"), { activeSceneId: sceneId });
    const shown = await pat.next("scene.snapshot");
    assert.deepEqual([shown.scene.id, shown.scene.version, shown.scene.scene.cells], [sceneId, 1, { "0,0": "floor" }]);

    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie, { visible: false });
    assert.deepEqual(await pat.next("scene.switch"), { activeSceneId: null });
    assert.deepEqual(await pat.next("scene.snapshot"), { editor: false, scene: null });
  });

  test("another current scene: the player gets scene.switch and its snapshot, the master only scene.switch", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const forest = (await call(site, "POST", `/api/games/${gameId}/scenes`, users.gm.cookie, { name: "Лес" })).body.id;
    await call(site, "PUT", `/api/games/${gameId}/scenes/${forest}`, users.gm.cookie, { visible: true });
    const gm = await Reader.of(site, gameId, users.gm);
    const pat = await Reader.of(site, gameId, users.pat);
    await gm.next("scene.snapshot");
    await pat.next("scene.snapshot");
    await call(site, "POST", `/api/games/${gameId}/scenes/${forest}/activate`, users.gm.cookie);
    assert.deepEqual(await pat.next("scene.switch"), { activeSceneId: forest });
    assert.equal((await pat.next("scene.snapshot")).scene.id, forest);
    assert.deepEqual(await gm.next("scene.switch"), { activeSceneId: forest });
    await gm.none("scene.snapshot");
  });

  test("the former master gets a player's snapshot after handing the game over, without reconnecting", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const hidden = (await call(site, "POST", `/api/games/${gameId}/scenes`, users.gm.cookie, { name: "Тайник" })).body.id;
    await call(site, "POST", `/api/games/${gameId}/scenes/${hidden}/activate`, users.gm.cookie);
    const gm = await Reader.of(site, gameId, users.gm);
    const pat = await Reader.of(site, gameId, users.pat);
    assert.equal((await gm.next("scene.snapshot")).scene.id, hidden);
    assert.deepEqual(await pat.next("scene.snapshot"), { editor: false, scene: null });

    await call(site, "POST", `/api/games/${gameId}/master`, users.gm.cookie, { userId: users.pat.id });
    assert.deepEqual(await gm.next("scene.switch"), { activeSceneId: null });
    assert.deepEqual(await gm.next("scene.snapshot"), { editor: false, scene: null }, "the hidden scene is no longer shown");
    const promoted = await pat.next("scene.snapshot");
    assert.deepEqual([promoted.editor, promoted.scene.id], [true, hidden]);

    // The former master's stream now gets only what a player sees.
    await patch(site, gameId, hidden, users.pat, [["cells", "0,0", "floor"]]);
    await gm.none("scene.patch");
    await call(site, "PUT", `/api/games/${gameId}/scenes/${hidden}`, users.pat.cookie, { visible: true });
    assert.equal((await gm.next("scene.snapshot")).scene.id, hidden);
    await patch(site, gameId, hidden, users.pat, [["cells", "1,0", "floor"]]);
    assert.equal((await gm.next("scene.patch")).version, 2);
    assert.ok(!gm.ended);
  });
});

describe("streams close at once", () => {
  test("a removed member and one who leaves lose the stream at once; the others see them go offline", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "sam");
    const { gameId } = await playedGame(site, users.gm, users.pat, users.sam);
    const gm = await Reader.of(site, gameId, users.gm);
    const pat = await Reader.of(site, gameId, users.pat);
    const sam = await Reader.of(site, gameId, users.sam);
    await until(() => gm.events.filter((entry) => entry.event === "presence").length >= 3, EVENT_TIMEOUT_MS, "all online");

    assert.equal((await call(site, "DELETE", `/api/games/${gameId}/members/${users.pat.id}`, users.gm.cookie)).status, 204);
    await pat.closedByServer();
    assertError(await Reader.open(site, `game=${gameId}`, users.pat.cookie).then((r) => ({ status: r.status, body: r.body })), "game.notFound");

    assert.equal((await call(site, "POST", `/api/games/${gameId}/leave`, users.sam.cookie)).status, 204);
    await sam.closedByServer();
    await until(
      () => gm.events.some((entry) => entry.event === "presence" && JSON.stringify(entry.data.online) === JSON.stringify([users.gm.id])),
      EVENT_TIMEOUT_MS,
      "only the master online",
    );
    assert.ok(!gm.ended);
  });

  test("deleting the game closes every stream of it", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const other = await playedGame(site, users.gm, users.pat);
    const readers = [await Reader.of(site, gameId, users.gm), await Reader.of(site, gameId, users.pat)];
    const elsewhere = await Reader.of(site, other.gameId, users.pat);
    assert.equal((await call(site, "DELETE", `/api/games/${gameId}`, users.gm.cookie)).status, 204);
    for (const reader of readers) await reader.closedByServer();
    await wait(100);
    assert.ok(!elsewhere.ended, "the streams of another game stay");
  });

  test("signing out closes the streams of that session only", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const second = await fetch(`${site.base}/api/auth/login`, {
      method: "POST",
      headers: { Origin: site.base, "Content-Type": "application/json" },
      body: JSON.stringify({ login: "pat", password: "pat-password" }),
    });
    const otherDevice = { ...users.pat, cookie: second.headers.get("set-cookie")?.match(/^bm_session=[^;]*/)?.[0] ?? "" };
    const here = await Reader.of(site, gameId, users.pat);
    const there = await Reader.of(site, gameId, otherDevice);
    assert.equal((await call(site, "POST", "/api/auth/logout", users.pat.cookie)).status, 204);
    await here.closedByServer();
    await wait(100);
    assert.ok(!there.ended, "the other device stays");
  });

  test("signing out with a cookie whose session already expired still closes its streams", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const pat = await Reader.of(site, gameId, users.pat);
    const gm = await Reader.of(site, gameId, users.gm);
    site.clock.now += SESSION_LIFETIME_MS + 1;
    assert.equal((await call(site, "POST", "/api/auth/logout", users.pat.cookie)).status, 204);
    await pat.closedByServer();
    await wait(100);
    assert.ok(!gm.ended, "another user's stream stays");
  });

  test("on a heartbeat a stream whose session expired or was deleted is closed; a live one stays", async () => {
    const { site, users } = await siteOf({ heartbeatMs: 50 }, "admin", "gm", "pat", "eve");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    await call(site, "POST", `/api/games/${gameId}/invites`, users.gm.cookie, { maxUses: 1, days: 7 }).then((invite) =>
      call(site, "POST", `/api/join/${invite.body.code}`, users.eve.cookie),
    );
    const pat = await Reader.of(site, gameId, users.pat);
    const eve = await Reader.of(site, gameId, users.eve);
    // Pat's session is gone from the database without a sign-out through this server (as when it expired and was cleaned).
    const db = new DatabaseSync(path.join(site.dir, "battlemap.db"));
    try {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(users.pat.id);
    } finally {
      db.close();
    }
    await pat.closedByServer();
    await wait(150);
    assert.ok(!eve.ended, "a live session keeps its stream over several heartbeats");
    // Everyone's session runs out: gm and eve used theirs last at the start.
    site.clock.now += SESSION_LIFETIME_MS + 1;
    await eve.closedByServer();
  });

  test("a new password closes the streams of the other sessions; a reset or disabling closes all of them", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const signIn = async (password: string): Promise<string> => {
      const response = await fetch(`${site.base}/api/auth/login`, {
        method: "POST",
        headers: { Origin: site.base, "Content-Type": "application/json" },
        body: JSON.stringify({ login: "pat", password }),
      });
      return response.headers.get("set-cookie")?.match(/^bm_session=[^;]*/)?.[0] ?? "";
    };
    const other = { ...users.pat, cookie: await signIn("pat-password") };
    const here = await Reader.of(site, gameId, users.pat);
    const there = await Reader.of(site, gameId, other);
    const changed = await call(site, "POST", "/api/me/password", users.pat.cookie, { currentPassword: "pat-password", newPassword: "pat-new-password" });
    assert.equal(changed.status, 200);
    await there.closedByServer();
    await wait(100);
    assert.ok(!here.ended, "the session that changed the password keeps its stream");

    await call(site, "POST", "/api/admin/users", users.admin.cookie, { action: "resetPassword", id: users.pat.id });
    await here.closedByServer();

    const gm = await Reader.of(site, gameId, users.gm);
    await call(site, "POST", "/api/admin/users", users.admin.cookie, { action: "setDisabled", id: users.gm.id, disabled: true });
    await gm.closedByServer();
  });

  test("the server closes the streams when it stops", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId } = await playedGame(site, users.gm);
    const gm = await Reader.of(site, gameId, users.gm);
    await gm.next("scene.snapshot");
    await site.server.close();
    await gm.closedByServer();
    site.server = (await start(site.dir, site.clock)).server;
  });
});

describe(`the heartbeat every ${HEARTBEAT_MS / 1000} s (artificial clocks)`, () => {
  /** The part of an HTTP answer a stream uses. */
  class FakeResponse extends EventEmitter {
    written = "";
    writableEnded = false;
    destroyed = false;
    writableLength = 0;
    writeHead(): void {}
    write(text: string): void {
      this.written += text;
    }
    end(): void {
      this.writableEnded = true;
      this.emit("close");
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("close");
    }
  }

  test("a comment line goes every 25 s to a stream of a live session; a dead session's stream is closed then instead", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const dead = new Set<string>();
    const streams = new Streams((tokenHash) => !dead.has(tokenHash.toString("hex")));
    t.after(() => streams.closeAll());
    const live = new FakeResponse();
    const ending = new FakeResponse();
    streams.open(live as unknown as ServerResponse, 1, 1, Buffer.from("aa", "hex"), {});
    streams.open(ending as unknown as ServerResponse, 2, 1, Buffer.from("bb", "hex"), {});

    t.mock.timers.tick(HEARTBEAT_MS - 1);
    assert.deepEqual([live.written, ending.written], ["", ""], "nothing before 25 s");
    t.mock.timers.tick(1);
    assert.deepEqual([live.written, ending.written], [":\n\n", ":\n\n"]);

    dead.add("bb");
    live.written = "";
    ending.written = "";
    t.mock.timers.tick(HEARTBEAT_MS);
    // Then who is online, since the other stream went.
    assert.equal(live.written, `:\n\nevent: presence\ndata: {"online":[1]}\n\n`);
    assert.equal(ending.written, "", "no heartbeat to a dead session");
    assert.equal(ending.writableEnded, true, "the dead session's stream is closed");
    assert.equal(live.writableEnded, false);
    assert.deepEqual(
      streams.ofGame(1).map((stream) => stream.userId),
      [1],
    );
  });
});

describe("pings (R6)", () => {
  test("a ping of a player reaches everyone who sees the scene, with the author's name, and is not stored", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "sam");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat, users.sam);
    const readers = [await Reader.of(site, gameId, users.gm), await Reader.of(site, gameId, users.pat), await Reader.of(site, gameId, users.sam)];
    const reply = await call(site, "POST", `/api/games/${gameId}/ping`, users.pat.cookie, { x: 2.5, y: -1.25 });
    assert.deepEqual([reply.status, reply.body], [204, undefined]);
    for (const reader of readers) {
      assert.deepEqual(await reader.next("ping"), { sceneId, x: 2.5, y: -1.25, userId: users.pat.id, name: "PAT" });
    }
    assert.equal((await call(site, "POST", `/api/games/${gameId}/ping`, users.gm.cookie, { x: 0, y: 0 })).status, 204, "the master too");
    assert.equal((await readers[1].next("ping")).name, "GM");
    assert.deepEqual([(await scene(site, gameId, sceneId, users.gm)).version, stored(site, sceneId).version], [0, 0]);
    await site.server.close();
    assert.deepEqual(stored(site, sceneId), { version: 0, state: newScene() }, "nothing written, also at the stop");
    site.server = (await start(site.dir, site.clock)).server;
  });

  test("a ping needs a member, a scene the author sees and a point of the board", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "eve");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    const pat = await Reader.of(site, gameId, users.pat);
    const ping = (person: Person | undefined, body: unknown) => call(site, "POST", `/api/games/${gameId}/ping`, person?.cookie, body);
    assertError(await ping(users.eve, { x: 0, y: 0 }), "game.notFound");
    assertError(await ping(undefined, { x: 0, y: 0 }), "auth.required");
    for (const body of [{}, { x: "1", y: 0 }, { x: 0 }, { x: 10001, y: 0 }, { x: 0, y: -10000 }, { x: null, y: 0 }]) {
      assertError(await ping(users.pat, body), "request.format", JSON.stringify(body));
    }
    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie, { visible: false });
    assertError(await ping(users.pat, { x: 0, y: 0 }), "scene.notFound", "the current scene hidden");
    assert.equal((await ping(users.gm, { x: 0, y: 0 })).status, 204, "the master pings a hidden current scene");
    await pat.none("ping");
  });

  test("a ping from another site is 403, one that is not JSON 415, and neither reaches anyone", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const gm = await Reader.of(site, gameId, users.gm);
    const send = async (headers: Record<string, string>, body: string): Promise<Reply> => {
      const response = await fetch(`${site.base}/api/games/${gameId}/ping`, { method: "POST", headers: { Cookie: users.pat.cookie, ...headers }, body });
      return { status: response.status, body: await response.json() };
    };
    const point = JSON.stringify({ x: 0, y: 0 });
    assertError(await send({ Origin: "http://evil.example", "Content-Type": "application/json" }, point), "request.origin", "a foreign Origin");
    assertError(await send({ Origin: site.base, "Content-Type": "text/plain" }, point), "request.contentType", "text/plain");
    assertError(await send({ Origin: site.base, "Content-Type": "application/x-www-form-urlencoded" }, "x=0&y=0"), "request.contentType", "a form");
    await gm.none("ping");
  });

  test(`at most ${MAX_PINGS} pings a second per user: more are 429 and reach nobody`, async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const gm = await Reader.of(site, gameId, users.gm);
    const ping = (person: Person) => call(site, "POST", `/api/games/${gameId}/ping`, person.cookie, { x: 1, y: 1 });
    for (let i = 0; i < MAX_PINGS; i++) assert.equal((await ping(users.pat)).status, 204);
    assertError(await ping(users.pat), "ping.tooMany");
    assert.equal((await ping(users.gm)).status, 204, "another user has pings of their own");
    await until(() => gm.events.filter((entry) => entry.event === "ping").length >= MAX_PINGS + 1, EVENT_TIMEOUT_MS, "pings");
    await wait(100);
    assert.equal(gm.events.filter((entry) => entry.event === "ping").length, MAX_PINGS + 1);
    site.clock.now += 1000;
    assert.equal((await ping(users.pat)).status, 204, "a second later");
  });
});

/** A database in a temporary folder, for tests on artificial clocks without the HTTP server. */
function tempDatabase(t: TestContext): Database {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-stream-"));
  const db = new Database(path.join(dir, "battlemap.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function insertPerson(db: Database, login: string) {
  return db.insertUser({
    login,
    displayName: login.toUpperCase(),
    passHash: new Uint8Array(32),
    passSalt: new Uint8Array(16),
    passParams: "scrypt:32768:8:1",
    role: "user",
    mustChangePassword: false,
    createdAt: 0,
  });
}

describe("writing scenes to the database (plan 8.6)", () => {
  test(`changes that never pause are written at most ${SAVE_CEILING_MS / 1000} s after the first one (artificial clocks)`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const db = tempDatabase(t);
    const owner = insertPerson(db, "gm_");
    const game = db.insertGame("Склеп", "gm", owner.id, owner.id, 0);
    const sceneId = db.insertScene(game.id, "Зал", JSON.stringify(newScene()), 0).id;
    const failures: unknown[] = [];
    const memory = new SceneMemory(db, () => Date.now(), (error) => failures.push(error));
    const record = () => {
      const found = db.findScene(game.id, sceneId);
      assert.ok(found);
      return found;
    };

    // A change every 500 ms for 12 s: the one-second pause never comes.
    const STEP_MS = 500;
    const writes: { at: number; stored: number; inMemory: number }[] = [];
    let inMemory = 0;
    for (let at = 0; at < 12_000; at += STEP_MS) {
      inMemory = memory.change(record(), [["cells", `${at / STEP_MS},0`, "floor"]]);
      const before = record().version;
      t.mock.timers.tick(STEP_MS);
      const after = record();
      if (after.version !== before) {
        writes.push({ at: Date.now(), stored: after.version, inMemory });
        assert.equal(Object.keys(JSON.parse(after.stateJson).cells).length, inMemory, "the written state has every change so far");
      }
    }
    assert.deepEqual(failures, []);
    assert.ok(writes.length > 0, "written while the changes went on");
    assert.ok(writes[0].at <= SAVE_CEILING_MS, `first write at ${writes[0].at} ms`);
    assert.deepEqual(writes[0], { at: SAVE_CEILING_MS, stored: SAVE_CEILING_MS / STEP_MS, inMemory: SAVE_CEILING_MS / STEP_MS });
    for (const write of writes) assert.equal(write.stored, write.inMemory, `at ${write.at} ms`);

    // After the last change the usual second.
    t.mock.timers.tick(SAVE_DELAY_MS);
    assert.equal(record().version, inMemory);
  });

  test(`a player's frequent small moves do not put the write off past ${SAVE_CEILING_MS / 1000} s; empty changes are refused`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    const db = tempDatabase(t);
    const streams = new Streams(() => true);
    t.after(() => streams.closeAll());
    const games = new Games(db, () => Date.now(), streams, (error) => assert.fail(String(error)));
    const gm = insertPerson(db, "gm_");
    const pat = insertPerson(db, "pat");
    const gameId = games.createGame(gm, "Склеп", "gm").id;
    const sceneId = games.createScene(gm, gameId, "Зал").id;
    games.updateScene(gm, gameId, sceneId, { visible: true });
    db.insertMember(gameId, pat.id, "player", 0);
    games.patchScene(gm, gameId, sceneId, [["tokens", "hero", token("Герой", "players", 0, 0)]]);
    t.mock.timers.tick(SAVE_DELAY_MS);
    const storedVersion = (): number | undefined => db.findScene(gameId, sceneId)?.version;
    assert.equal(storedVersion(), 1);

    // A move and an empty change every 300 ms for 12 s; the database is looked at every 100 ms.
    const STEP_MS = 300;
    const LOOK_MS = 100;
    const start = Date.now();
    let firstWrite: number | null = null;
    let version = 1;
    for (let step = 0; step < 12_000 / STEP_MS; step++) {
      assert.throws(
        () => games.patchScene(pat, gameId, sceneId, []),
        (error) => error instanceof ApiError && error.code === "scene.patch",
      );
      version = games.patchScene(pat, gameId, sceneId, [["tokens", "hero", token("Герой", "players", step % 2, 0)]]).version;
      for (let looked = 0; looked < STEP_MS; looked += LOOK_MS) {
        t.mock.timers.tick(LOOK_MS);
        if (firstWrite === null && storedVersion() !== 1) firstWrite = Date.now() - start;
      }
    }
    assert.ok(firstWrite !== null && firstWrite <= SAVE_CEILING_MS, `the first write ${firstWrite} ms after the first move`);
    assert.equal(version, 1 + 12_000 / STEP_MS, "only the moves raised the version");
    t.mock.timers.tick(SAVE_DELAY_MS);
    assert.equal(storedVersion(), version);
  });

  test("over the memory limit the scenes changed longest ago are written and dropped; nothing is lost", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const db = tempDatabase(t);
    const owner = insertPerson(db, "gm_");
    const game = db.insertGame("Склеп", "gm", owner.id, owner.id, 0);
    const [a, b, c] = ["A", "B", "C"].map((name) => db.insertScene(game.id, name, JSON.stringify(newScene()), 0).id);
    const record = (sceneId: number) => {
      const found = db.findScene(game.id, sceneId);
      assert.ok(found);
      return found;
    };
    // Room for two scenes of one cell, not for three.
    const probe = newScene();
    applyPatch(probe, [["cells", "0,0", "floor"]]);
    const size = Buffer.byteLength(JSON.stringify(probe));
    const memory = new SceneMemory(db, () => Date.now(), (error) => assert.fail(String(error)), 2 * size + Math.floor(size / 2));

    const oneCell: Patch = [["cells", "0,0", "floor"]];
    memory.change(record(a), oneCell);
    t.mock.timers.tick(100);
    memory.change(record(b), oneCell);
    t.mock.timers.tick(100);
    // A again: now B is the one changed longest ago.
    assert.equal(memory.change(record(a), oneCell), 2);
    t.mock.timers.tick(100);
    memory.change(record(c), oneCell);

    assert.deepEqual([memory.isLoaded(a), memory.isLoaded(b), memory.isLoaded(c)], [true, false, true]);
    assert.equal(memory.bytes, 2 * size);
    assert.deepEqual([record(b).version, JSON.parse(record(b).stateJson).cells], [1, { "0,0": "floor" }], "B is written before it is dropped");
    assert.deepEqual([record(a).version, record(c).version], [0, 0], "the others wait for their second");

    // The next change of B reads it from the database and goes on from its version.
    assert.equal(memory.change(record(b), [["cells", "1,0", "floor"]]), 2);
    assert.equal(memory.isLoaded(a), false, "now A is the one changed longest ago");
    assert.deepEqual([record(a).version, JSON.parse(record(a).stateJson).cells], [2, { "0,0": "floor" }]);
    t.mock.timers.tick(SAVE_DELAY_MS);
    assert.deepEqual(
      [a, b, c].map((sceneId) => [record(sceneId).version, JSON.parse(record(sceneId).stateJson).cells]),
      [
        [2, { "0,0": "floor" }],
        [2, { "0,0": "floor", "1,0": "floor" }],
        [1, { "0,0": "floor" }],
      ],
    );
  });

  test(`a written scene stays in memory until ${IDLE_UNLOAD_MS / 1000} s after its last change`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const db = tempDatabase(t);
    const owner = insertPerson(db, "gm_");
    const game = db.insertGame("Склеп", "gm", owner.id, owner.id, 0);
    const sceneId = db.insertScene(game.id, "Зал", JSON.stringify(newScene()), 0).id;
    const record = () => {
      const found = db.findScene(game.id, sceneId);
      assert.ok(found);
      return found;
    };
    const memory = new SceneMemory(db, () => Date.now(), (error) => assert.fail(String(error)));
    memory.change(record(), [["cells", "0,0", "floor"]]);
    t.mock.timers.tick(SAVE_DELAY_MS);
    assert.deepEqual([record().version, memory.isLoaded(sceneId)], [1, true], "written and still in memory");
    t.mock.timers.tick(IDLE_UNLOAD_MS - SAVE_DELAY_MS - 1);
    assert.equal(memory.isLoaded(sceneId), true);
    t.mock.timers.tick(1);
    assert.deepEqual([memory.isLoaded(sceneId), memory.bytes], [false, 0]);
    assert.equal(memory.change(record(), [["cells", "1,0", "floor"]]), 2, "read again from the database");
  });

  test("a change is written a second after the last change of the scene", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId, sceneId } = await playedGame(site, users.gm);
    await patch(site, gameId, sceneId, users.gm, [["cells", "0,0", "floor"]]);
    assert.equal(stored(site, sceneId).version, 0, "not at once");
    assert.equal((await scene(site, gameId, sceneId, users.gm)).version, 1, "but the scene has it");
    await wait(SAVE_DELAY_MS / 2);
    await patch(site, gameId, sceneId, users.gm, [["cells", "1,0", "grass"]]);
    assert.equal(stored(site, sceneId).version, 0, "a new change moves the write");
    await until(() => stored(site, sceneId).version === 2, 3 * SAVE_DELAY_MS, "the write");
    assert.deepEqual(stored(site, sceneId).state.cells, { "0,0": "floor", "1,0": "grass" });
  });

  test("a change is written when the server stops, and is there after the start", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    await patch(site, gameId, sceneId, users.gm, [["tokens", "hero", token("Герой", "players")]]);
    await patch(site, gameId, sceneId, users.pat, [["tokens", "hero", token("Герой", "players", 3, 2)]]);
    await site.server.close();
    assert.equal(stored(site, sceneId).version, 2);
    const again = await start(site.dir, site.clock);
    site.server = again.server;
    site.base = again.base;
    const after = await scene(site, gameId, sceneId, users.pat);
    assert.deepEqual([after.version, after.scene.tokens.hero.x, after.scene.tokens.hero.y], [2, 3, 2]);
  });

  test("a deleted game is not written back", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const { gameId, sceneId } = await playedGame(site, users.gm);
    await patch(site, gameId, sceneId, users.gm, [["cells", "0,0", "floor"]]);
    assert.equal((await call(site, "DELETE", `/api/games/${gameId}`, users.gm.cookie)).status, 204);
    await wait(SAVE_DELAY_MS * 1.5);
    await site.server.close();
    const db = new DatabaseSync(path.join(site.dir, "battlemap.db"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM scenes").get()?.n, 0);
    } finally {
      db.close();
    }
    site.server = (await start(site.dir, site.clock)).server;
  });
});

describe("the board and the stream (client/src/app/live.ts)", () => {
  /** A board: its scene, history and live state; `change` makes a local change like a tool and returns what it sends. */
  function boardOf(server: { scene: Scene; version: number }) {
    const live = new LiveScene(1, structuredClone(server.scene), server.version);
    const history = newHistory();
    return {
      live,
      change(patch: Patch): Patch {
        beginChange(history);
        applyToChange(live.scene, history, patch);
        assert.equal(finishChange(history), true);
        const inverse = history.undo[history.undo.length - 1];
        const forward = forwardPatch(live.scene, inverse);
        live.local(forward, inverse);
        return forward;
      },
    };
  }

  /** The server: applies what it gets in order and gives each change the next version. */
  function serverOf() {
    const server = { scene: newScene(), version: 0, log: [] as { version: number; patch: Patch }[] };
    return {
      server,
      accept(patch: Patch): void {
        applyPatch(server.scene, patch);
        server.version++;
        server.log.push({ version: server.version, patch });
      },
    };
  }

  test("two boards changing the same cells end with the server's scene, whatever the order of the answers", () => {
    const { server, accept } = serverOf();
    const a = boardOf(server);
    const b = boardOf(server);
    const fromA = [a.change([["cells", "0,0", "floor"]]), a.change([["cells", "1,0", "floor"], ["cells", "0,0", "wood"]])];
    const fromB = [b.change([["cells", "0,0", "grass"]]), b.change([["cells", "2,0", "sand"]])];
    // The server gets them interleaved: A1, B1, A2, B2.
    for (const change of [fromA[0], fromB[0], fromA[1], fromB[1]]) accept(change);
    // A hears the first two before its second change comes back; B hears them all.
    const results = { a: [] as string[], b: [] as string[] };
    for (const { version, patch } of server.log) {
      results.a.push(a.live.receive(version, patch));
      results.b.push(b.live.receive(version, patch));
    }
    assert.deepEqual(results, { a: ["own", "applied", "own", "applied"], b: ["applied", "own", "applied", "own"] });
    assert.deepEqual(a.live.scene, server.scene);
    assert.deepEqual(b.live.scene, server.scene);
  });

  test("a change of someone else goes under the board's own changes until they come back", () => {
    const { server, accept } = serverOf();
    const board = boardOf(server);
    const mine = board.change([["cells", "0,0", "floor"]]);
    const theirs: Patch = [["cells", "0,0", "lava"], ["cells", "5,5", "grass"]];
    accept(theirs);
    assert.equal(board.live.receive(1, theirs), "applied");
    assert.deepEqual(board.live.scene.cells, { "0,0": "floor", "5,5": "grass" }, "mine still shows on top");
    accept(mine);
    assert.equal(board.live.receive(2, mine), "own");
    assert.deepEqual(board.live.scene, server.scene);
  });

  test("an old change is skipped and a missed one asks for the scene again", () => {
    const board = boardOf({ scene: newScene(), version: 4 });
    assert.equal(board.live.receive(4, [["cells", "0,0", "floor"]]), "old");
    assert.equal(board.live.receive(6, [["cells", "0,0", "floor"]]), "gap");
    assert.deepEqual(board.live.scene.cells, {});
    assert.equal(board.live.receive(5, [["cells", "0,0", "floor"]]), "applied");
    assert.equal(board.live.version, 5);
  });

  test("a change that is not valid throws before the scene is touched", () => {
    const board = boardOf({ scene: newScene(), version: 0 });
    board.change([["cells", "0,0", "floor"]]);
    assert.throws(() => board.live.receive(1, [["cells", "0,0", "plasma"]] as Patch));
    assert.deepEqual([board.live.scene.cells, board.live.version], [{ "0,0": "floor" }, 0]);
  });
});
