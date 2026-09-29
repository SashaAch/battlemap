// Games, personal campaigns, invites, members and scenes (plan 5.4, 5.11, 6.2, 6.4, 8.5), through real HTTP
// on a free port of 127.0.0.1 with the data in a temporary folder. Every right has a test of the refusal.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { forwardPatch } from "../client/src/app/api.ts";
import { applyPatch, applyToChange, beginChange, finishChange, newHistory, newScene, redo, undo } from "../client/src/board/store.ts";
import type { Patch } from "../client/src/board/store.ts";
import { startServer } from "../server/app.ts";
import type { RunningServer } from "../server/app.ts";
import { DAY_MS } from "../server/auth.ts";
import { ERRORS } from "../server/errors.ts";
import type { ErrorCode } from "../server/errors.ts";
import { MAX_JOIN_FAILURES_PER_ADDRESS } from "../server/games.ts";

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

async function start(dir: string, clock: { now: number }): Promise<Site> {
  const server = await startServer({ dataDir: dir, host: "127.0.0.1", port: 0, now: () => clock.now, log: () => undefined });
  return { dir, server, base: `http://127.0.0.1:${server.port}`, clock };
}

async function restart(site: Site): Promise<void> {
  await site.server.close();
  const again = await start(site.dir, site.clock);
  site.server = again.server;
  site.base = again.base;
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
}

/** A site with users registered under these logins; the first one is the administrator. */
async function siteWith(...logins: string[]): Promise<{ site: Site; users: Record<string, Person> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-games-"));
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ openRegistration: true }));
  const site = await start(dir, { now: Date.UTC(2026, 0, 1) });
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
    users[login] = { id: ((await response.json()) as { id: number }).id, cookie };
  }
  return { site, users };
}

async function createGame(site: Site, owner: Person, kind: "gm" | "personal" = "gm", title = "Склеп"): Promise<number> {
  const reply = await call(site, "POST", "/api/games", owner.cookie, { title, kind });
  assert.equal(reply.status, 201);
  return reply.body.id;
}

async function createScene(site: Site, gameId: number, editor: Person, name = "Зал"): Promise<number> {
  const reply = await call(site, "POST", `/api/games/${gameId}/scenes`, editor.cookie, { name });
  assert.equal(reply.status, 201);
  return reply.body.id;
}

async function invite(site: Site, gameId: number, editor: Person, days = 7): Promise<string> {
  const reply = await call(site, "POST", `/api/games/${gameId}/invites`, editor.cookie, { days });
  assert.equal(reply.status, 201);
  assert.match(reply.body.code, /^[a-z0-9]{16}$/);
  return reply.body.code;
}

async function join(site: Site, code: string, person: Person): Promise<Reply> {
  return call(site, "POST", `/api/join/${code}`, person.cookie);
}

/** A game of `gm` with `players` joined by one invite and one scene, current and visible. */
async function playedGame(site: Site, gm: Person, ...players: Person[]): Promise<{ gameId: number; sceneId: number; code: string }> {
  const gameId = await createGame(site, gm);
  const sceneId = await createScene(site, gameId, gm);
  assert.equal((await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, gm.cookie, { visible: true })).status, 200);
  const code = await invite(site, gameId, gm);
  for (const player of players) assert.equal((await join(site, code, player)).status, 200);
  return { gameId, sceneId, code };
}

const patch = (site: Site, gameId: number, sceneId: number, person: Person, change: unknown): Promise<Reply> =>
  call(site, "POST", `/api/games/${gameId}/scenes/${sceneId}/patch`, person.cookie, { patch: change });

const FLOOR: unknown = [["cells", "0,0", "floor"]];

/** Every request about one game and scene, with a body that would pass if the rights allowed it. */
function gameRequests(gameId: number, sceneId: number, userId: number): [string, string, unknown][] {
  const scene = `/api/games/${gameId}/scenes/${sceneId}`;
  return [
    ["GET", `/api/games/${gameId}`, undefined],
    ["GET", `/api/games/${gameId}/scenes`, undefined],
    ["POST", `/api/games/${gameId}/scenes`, { name: "Новая" }],
    ["GET", scene, undefined],
    ["PUT", scene, { name: "Другая", visible: false }],
    ["POST", `${scene}/patch`, { patch: FLOOR }],
    ["POST", `${scene}/activate`, {}],
    ["POST", `/api/games/${gameId}/invites`, { days: 1 }],
    ["POST", `/api/games/${gameId}/master`, { userId }],
    ["DELETE", `/api/games/${gameId}/members/${userId}`, {}],
    ["DELETE", `/api/games/${gameId}`, {}],
  ];
}

// ---- tests ----

describe("games and my games", () => {
  test("a game has its creator as master; a personal campaign has no master; my games lists both", async () => {
    const { site, users } = await siteWith("admin", "anna");
    const game = await call(site, "POST", "/api/games", users.anna.cookie, { title: "  Склеп  ", kind: "gm" });
    assert.equal(game.status, 201);
    assert.equal(game.body.title, "Склеп");
    assert.deepEqual(
      [game.body.kind, game.body.gmId, game.body.ownerId, game.body.role, game.body.editor],
      ["gm", users.anna.id, users.anna.id, "gm", true],
    );
    const campaign = await call(site, "POST", "/api/games", users.anna.cookie, { title: "Моя кампания", kind: "personal" });
    assert.deepEqual([campaign.body.gmId, campaign.body.role, campaign.body.editor, campaign.body.isOwner], [null, "player", true, true]);

    const list = await call(site, "GET", "/api/games", users.anna.cookie);
    assert.deepEqual(
      list.body.games.map((entry: any) => [entry.title, entry.kind, entry.role, entry.isOwner, entry.hasMaster]),
      [
        ["Моя кампания", "personal", "player", true, false],
        ["Склеп", "gm", "gm", true, true],
      ],
    );
    assert.deepEqual((await call(site, "GET", "/api/games", users.admin.cookie)).body.games, [], "another user's games are not listed");
  });

  test("titles, names and kinds are checked", async () => {
    const { site, users } = await siteWith("admin", "anna");
    for (const title of ["", "   ", "x".repeat(41), "a\u0007b"]) {
      assertError(await call(site, "POST", "/api/games", users.anna.cookie, { title, kind: "gm" }), "game.title", JSON.stringify(title));
    }
    assertError(await call(site, "POST", "/api/games", users.anna.cookie, { title: "Игра", kind: "solo" }), "request.format");
    assertError(await call(site, "POST", "/api/games", users.anna.cookie, { title: 5, kind: "gm" }), "request.format");
    const gameId = await createGame(site, users.anna);
    assertError(await call(site, "POST", `/api/games/${gameId}/scenes`, users.anna.cookie, { name: "x".repeat(41) }), "scene.name");
    const sceneId = await createScene(site, gameId, users.anna);
    assertError(await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.anna.cookie, { name: "" }), "scene.name");
    assertError(await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.anna.cookie, { visible: "yes" }), "request.format");
    assertError(await call(site, "POST", `/api/games/${gameId}/invites`, users.anna.cookie, { days: 366 }), "request.format");
    assertError(await call(site, "POST", `/api/games/${gameId}/invites`, users.anna.cookie, { days: 0 }), "request.format");
  });

  test("after a restart my games and the current scene are the same", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    const second = await createScene(site, gameId, users.gm, "Лес");
    await call(site, "PUT", `/api/games/${gameId}/scenes/${second}`, users.gm.cookie, { visible: true });
    assert.equal((await call(site, "POST", `/api/games/${gameId}/scenes/${second}/activate`, users.gm.cookie)).status, 204);
    assert.equal((await patch(site, gameId, second, users.gm, FLOOR)).status, 200);
    const before = await Promise.all([users.gm, users.pat].map((person) => call(site, "GET", "/api/games", person.cookie)));

    await restart(site);

    for (const [index, person] of [users.gm, users.pat].entries()) {
      assert.deepEqual((await call(site, "GET", "/api/games", person.cookie)).body, before[index].body);
      const game = await call(site, "GET", `/api/games/${gameId}`, person.cookie);
      assert.equal(game.body.activeSceneId, second);
      const scene = await call(site, "GET", `/api/games/${gameId}/scenes/${second}`, person.cookie);
      assert.deepEqual([scene.body.name, scene.body.active, scene.body.scene.cells], ["Лес", true, { "0,0": "floor" }]);
    }
  });
});

describe("rights in a game", () => {
  test("someone who is not a member gets 404 for the game and everything in it, the same as for a game that does not exist", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "eve");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    for (const [method, url, body] of gameRequests(gameId, sceneId, users.pat.id)) {
      assertError(await call(site, method, url, users.eve.cookie, body), "game.notFound", `${method} ${url}`);
      assertError(await call(site, method, url, users.admin.cookie, body), "game.notFound", `administrator: ${method} ${url}`);
    }
    for (const [method, url, body] of gameRequests(gameId + 100, sceneId, users.pat.id)) {
      assertError(await call(site, method, url, users.gm.cookie, body), "game.notFound", `missing game: ${method} ${url}`);
    }
    // Nothing changed.
    const game = await call(site, "GET", `/api/games/${gameId}`, users.gm.cookie);
    assert.deepEqual(game.body.members.map((member: any) => member.id), [users.gm.id, users.pat.id]);
    assert.equal((await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie)).body.version, 0);
  });

  test("without a session every game request gets 401", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const gameId = await createGame(site, users.gm);
    const sceneId = await createScene(site, gameId, users.gm);
    const requests: [string, string, unknown][] = [
      ["GET", "/api/games", undefined],
      ["POST", "/api/games", { title: "Игра", kind: "gm" }],
      ["POST", "/api/join/abcdefghijkmnpqr", {}],
      ...gameRequests(gameId, sceneId, users.gm.id),
    ];
    for (const [method, url, body] of requests) assertError(await call(site, method, url, undefined, body), "auth.required", `${method} ${url}`);
  });

  test("a player cannot create a scene (403), nor change, show, activate, invite, remove or hand over", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "sam");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat, users.sam);
    const refused = gameRequests(gameId, sceneId, users.sam.id).filter(([method]) => method !== "GET");
    for (const [method, url, body] of refused) {
      assertError(await call(site, method, url, users.pat.cookie, body), "auth.forbidden", `${method} ${url}`);
    }
    const game = await call(site, "GET", `/api/games/${gameId}`, users.gm.cookie);
    assert.deepEqual(game.body.scenes.map((scene: any) => [scene.name, scene.visible, scene.version]), [["Зал", true, 0]]);
    assert.equal(game.body.members.length, 3);
    assert.equal(game.body.gmId, users.gm.id);
  });

  test("a player sees only the current scene while it is visible; other scenes are 404, not 403", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    const hidden = await createScene(site, gameId, users.gm, "Тайник");

    const seen = await call(site, "GET", `/api/games/${gameId}`, users.pat.cookie);
    assert.deepEqual([seen.body.activeSceneId, seen.body.scenes.map((scene: any) => scene.id)], [sceneId, [sceneId]]);
    assert.equal((await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.pat.cookie)).status, 200);
    assert.deepEqual((await call(site, "GET", `/api/games/${gameId}/scenes`, users.pat.cookie)).body.scenes.length, 1);

    // A hidden scene: 404 whatever the player tries, also where the rights would give 403.
    for (const [method, url, body] of gameRequests(gameId, hidden, users.pat.id).filter(([, url]) => url.includes("/scenes/"))) {
      assertError(await call(site, method, url, users.pat.cookie, body), "scene.notFound", `${method} ${url}`);
    }
    // The current scene hidden: the player does not even learn which one is current.
    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie, { visible: false });
    const curtain = await call(site, "GET", `/api/games/${gameId}`, users.pat.cookie);
    assert.deepEqual([curtain.body.activeSceneId, curtain.body.scenes], [null, []]);
    assertError(await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.pat.cookie), "scene.notFound");
    // A visible scene that is not current is not shown either.
    await call(site, "PUT", `/api/games/${gameId}/scenes/${hidden}`, users.gm.cookie, { visible: true });
    assertError(await call(site, "GET", `/api/games/${gameId}/scenes/${hidden}`, users.pat.cookie), "scene.notFound");
    // The master sees all of them.
    assert.equal((await call(site, "GET", `/api/games/${gameId}/scenes`, users.gm.cookie)).body.scenes.length, 2);
  });

  test("a scene of another game is 404, even to the master of both", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const first = await createGame(site, users.gm);
    const second = await createGame(site, users.gm, "gm", "Другая");
    const sceneId = await createScene(site, second, users.gm);
    for (const [method, url, body] of gameRequests(first, sceneId, users.gm.id).filter(([, url]) => url.includes("/scenes/"))) {
      assertError(await call(site, method, url, users.gm.cookie, body), "scene.notFound", `${method} ${url}`);
    }
  });

  test("malformed ids and codes in the path are unknown requests", async () => {
    const { site, users } = await siteWith("admin", "gm");
    for (const url of ["/api/games/0", "/api/games/01", "/api/games/abc", "/api/games/1234567890123456", "/api/games/1/scenes/x"]) {
      assertError(await call(site, "GET", url, users.gm.cookie), "request.notFound", url);
    }
    assertError(await call(site, "POST", "/api/join/ABC", users.gm.cookie), "request.notFound");
    assertError(await call(site, "POST", "/api/join/a-b", users.gm.cookie), "request.notFound");
  });
});

describe("invites", () => {
  test("a player joins by a code; joining again does not add them twice; the code serves several players", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "sam");
    const gameId = await createGame(site, users.gm);
    const code = await invite(site, gameId, users.gm);
    assert.deepEqual((await join(site, code, users.pat)).body, { gameId });
    assert.deepEqual((await join(site, code, users.pat)).body, { gameId });
    assert.deepEqual((await join(site, code, users.gm)).body, { gameId }, "the master stays master");
    assert.equal((await join(site, code, users.sam)).status, 200);
    const game = await call(site, "GET", `/api/games/${gameId}`, users.gm.cookie);
    assert.deepEqual(
      game.body.members.map((member: any) => [member.id, member.displayName, member.role]),
      [
        [users.gm.id, "GM", "gm"],
        [users.pat.id, "PAT", "player"],
        [users.sam.id, "SAM", "player"],
      ],
    );
    const list = await call(site, "GET", "/api/games", users.pat.cookie);
    assert.deepEqual(list.body.games.map((entry: any) => [entry.id, entry.role, entry.isOwner]), [[gameId, "player", false]]);
  });

  test("an expired invite is 410, an unknown one 404", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const gameId = await createGame(site, users.gm);
    const code = await invite(site, gameId, users.gm, 2);
    site.clock.now += 2 * DAY_MS;
    assertError(await join(site, code, users.pat), "invite.expired");
    assertError(await join(site, "abcdefghijkmnpqr", users.pat), "invite.notFound");
    assertError(await call(site, "GET", `/api/games/${gameId}`, users.pat.cookie), "game.notFound");
  });

  test("a registration code does not open a game, and a game code does not register", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-games-"));
    const site = await start(dir, { now: Date.UTC(2026, 0, 1) });
    cleanups.push(async () => {
      await site.server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const link = site.server.setupLink ?? "";
    const admin = await fetch(`${site.base}/api/auth/register`, {
      method: "POST",
      headers: { Origin: site.base, "Content-Type": "application/json" },
      body: JSON.stringify({ login: "admin", displayName: "A", password: "admin-password", setup: link.slice(link.indexOf("#setup=") + 7) }),
    });
    const cookie = admin.headers.get("set-cookie")?.match(/^bm_session=[^;]*/)?.[0];
    const registration = await call(site, "POST", "/api/admin/invites", cookie, { maxUses: 5, days: 5 });
    assertError(await join(site, registration.body.code, { id: 1, cookie: cookie ?? "" }), "invite.notFound");
    const gameId = await createGame(site, { id: 1, cookie: cookie ?? "" });
    const code = await invite(site, gameId, { id: 1, cookie: cookie ?? "" });
    const register = await call(site, "POST", "/api/auth/register", undefined, { login: "pat", displayName: "P", password: "pat-password", code });
    assertError(register, "auth.inviteInvalid");
  });

  test("failed joins count per address: after 10 even a good code gets 429", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const gameId = await createGame(site, users.gm);
    const code = await invite(site, gameId, users.gm);
    for (let i = 0; i < MAX_JOIN_FAILURES_PER_ADDRESS; i++) assertError(await join(site, `wrong${i}`, users.pat), "invite.notFound");
    assertError(await join(site, code, users.pat), "invite.tooManyAttempts");
    site.clock.now += 15 * 60 * 1000;
    assert.equal((await join(site, code, users.pat)).status, 200);
  });

  test("good joins do not count against the address", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const gameId = await createGame(site, users.gm);
    const code = await invite(site, gameId, users.gm);
    for (let i = 0; i < MAX_JOIN_FAILURES_PER_ADDRESS + 5; i++) assert.equal((await join(site, code, users.pat)).status, 200);
  });
});

describe("members and the master", () => {
  test("a removed player loses access at once and cannot come back with the old code", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "sam");
    const { gameId, sceneId, code } = await playedGame(site, users.gm, users.pat, users.sam);
    assert.equal((await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.pat.cookie)).status, 200);

    assert.equal((await call(site, "DELETE", `/api/games/${gameId}/members/${users.pat.id}`, users.gm.cookie)).status, 204);

    for (const [method, url, body] of gameRequests(gameId, sceneId, users.sam.id)) {
      assertError(await call(site, method, url, users.pat.cookie, body), "game.notFound", `${method} ${url}`);
    }
    assert.deepEqual((await call(site, "GET", "/api/games", users.pat.cookie)).body.games, []);
    assertError(await join(site, code, users.pat), "invite.notFound");
    assert.equal((await call(site, "GET", `/api/games/${gameId}`, users.sam.cookie)).status, 200, "the others stay");
    assertError(await call(site, "DELETE", `/api/games/${gameId}/members/${users.pat.id}`, users.gm.cookie), "member.notFound");
  });

  test("the owner and the master cannot be removed", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat");
    const { gameId } = await playedGame(site, users.gm, users.pat);
    assertError(await call(site, "DELETE", `/api/games/${gameId}/members/${users.gm.id}`, users.gm.cookie), "member.protected");
    assert.equal((await call(site, "POST", `/api/games/${gameId}/master`, users.gm.cookie, { userId: users.pat.id })).status, 200);
    assertError(await call(site, "DELETE", `/api/games/${gameId}/members/${users.gm.id}`, users.pat.cookie), "member.protected", "the owner");
    assertError(await call(site, "DELETE", `/api/games/${gameId}/members/${users.pat.id}`, users.pat.cookie), "member.protected", "the master");
  });

  test("the master hands the game to a member: the new master edits, the old one gets 403", async () => {
    const { site, users } = await siteWith("admin", "gm", "pat", "eve");
    const { gameId, sceneId } = await playedGame(site, users.gm, users.pat);
    assertError(await call(site, "POST", `/api/games/${gameId}/master`, users.gm.cookie, { userId: users.eve.id }), "member.notFound");

    const handed = await call(site, "POST", `/api/games/${gameId}/master`, users.gm.cookie, { userId: users.pat.id });
    assert.equal(handed.status, 200);
    assert.deepEqual(
      [handed.body.gmId, handed.body.role, handed.body.editor, handed.body.isOwner],
      [users.pat.id, "player", false, true],
    );
    assert.deepEqual(handed.body.members.map((member: any) => member.role), ["player", "gm"]);

    assertError(await patch(site, gameId, sceneId, users.gm, FLOOR), "auth.forbidden");
    assertError(await call(site, "POST", `/api/games/${gameId}/master`, users.gm.cookie, { userId: users.gm.id }), "auth.forbidden");
    assert.deepEqual((await patch(site, gameId, sceneId, users.pat, FLOOR)).body, { version: 1 });
    const game = await call(site, "GET", `/api/games/${gameId}`, users.pat.cookie);
    assert.deepEqual([game.body.role, game.body.editor], ["gm", true]);
  });
});

describe("personal campaign (R24)", () => {
  test("the owner edits its scenes without a master", async () => {
    const { site, users } = await siteWith("admin", "anna");
    const gameId = await createGame(site, users.anna, "personal");
    const sceneId = await createScene(site, gameId, users.anna);
    assert.deepEqual((await patch(site, gameId, sceneId, users.anna, FLOOR)).body, { version: 1 });
    assert.equal((await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.anna.cookie, { name: "Дом" })).body.name, "Дом");
    assert.equal((await call(site, "GET", `/api/games/${gameId}`, users.anna.cookie)).body.activeSceneId, sceneId, "the first scene is current");
  });

  test("after the owner names a master, the owner's change of a scene is 403 and the master's passes", async () => {
    const { site, users } = await siteWith("admin", "anna", "gm");
    const gameId = await createGame(site, users.anna, "personal");
    const sceneId = await createScene(site, gameId, users.anna);
    // Shown to players, so that a player gets 403 for it and not 404.
    await call(site, "PUT", `/api/games/${gameId}/scenes/${sceneId}`, users.anna.cookie, { visible: true });
    const code = await invite(site, gameId, users.anna);
    await join(site, code, users.gm);
    assertError(await patch(site, gameId, sceneId, users.gm, FLOOR), "auth.forbidden", "not a master yet");

    const named = await call(site, "POST", `/api/games/${gameId}/master`, users.anna.cookie, { userId: users.gm.id });
    assert.deepEqual([named.body.gmId, named.body.isOwner, named.body.editor], [users.gm.id, true, false]);

    assertError(await patch(site, gameId, sceneId, users.anna, FLOOR), "auth.forbidden");
    assertError(await call(site, "POST", `/api/games/${gameId}/scenes`, users.anna.cookie, { name: "Ещё" }), "auth.forbidden");
    assertError(await call(site, "POST", `/api/games/${gameId}/master`, users.anna.cookie, { userId: users.anna.id }), "auth.forbidden");
    assert.deepEqual((await patch(site, gameId, sceneId, users.gm, FLOOR)).body, { version: 1 });
  });

  test("only the owner deletes the campaign: not the master, not a player; then it is gone for everyone", async () => {
    const { site, users } = await siteWith("admin", "anna", "gm", "pat", "eve");
    const gameId = await createGame(site, users.anna, "personal");
    const sceneId = await createScene(site, gameId, users.anna);
    const code = await invite(site, gameId, users.anna);
    await join(site, code, users.gm);
    await join(site, code, users.pat);
    await call(site, "POST", `/api/games/${gameId}/master`, users.anna.cookie, { userId: users.gm.id });

    assertError(await call(site, "DELETE", `/api/games/${gameId}`, users.gm.cookie), "auth.forbidden");
    assertError(await call(site, "DELETE", `/api/games/${gameId}`, users.pat.cookie), "auth.forbidden");
    assertError(await call(site, "DELETE", `/api/games/${gameId}`, users.eve.cookie), "game.notFound");
    assert.equal((await call(site, "GET", `/api/games/${gameId}`, users.anna.cookie)).status, 200);

    assert.equal((await call(site, "DELETE", `/api/games/${gameId}`, users.anna.cookie)).status, 204);
    for (const person of [users.anna, users.gm, users.pat]) {
      assertError(await call(site, "GET", `/api/games/${gameId}`, person.cookie), "game.notFound");
      assertError(await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, person.cookie), "game.notFound");
      assert.deepEqual((await call(site, "GET", "/api/games", person.cookie)).body.games, []);
    }
    assertError(await join(site, code, users.eve), "invite.notFound");
  });
});

describe("scenes", () => {
  test("the master creates, renames, shows and activates scenes; a new scene is hidden", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const gameId = await createGame(site, users.gm);
    const first = await call(site, "POST", `/api/games/${gameId}/scenes`, users.gm.cookie, { name: "Зал" });
    assert.deepEqual(
      { ...first.body, scene: undefined },
      { id: first.body.id, name: "Зал", visible: false, active: true, version: 0, scene: undefined },
    );
    assert.deepEqual(first.body.scene, { v: 1, settings: {}, cells: {}, rooms: {}, edges: {}, objects: {}, tokens: {}, marks: {}, revealed: {} });
    const second = await createScene(site, gameId, users.gm, "Лес");
    const renamed = await call(site, "PUT", `/api/games/${gameId}/scenes/${second}`, users.gm.cookie, { name: "Тёмный лес", visible: true });
    assert.deepEqual(renamed.body, { id: second, name: "Тёмный лес", visible: true, active: false, version: 0 });
    await call(site, "POST", `/api/games/${gameId}/scenes/${second}/activate`, users.gm.cookie);
    const list = await call(site, "GET", `/api/games/${gameId}/scenes`, users.gm.cookie);
    assert.deepEqual(
      list.body.scenes.map((scene: any) => [scene.name, scene.visible, scene.active]),
      [
        ["Зал", false, false],
        ["Тёмный лес", true, true],
      ],
    );
  });

  test("a change is applied and saved, and each one gives a new version", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const gameId = await createGame(site, users.gm);
    const sceneId = await createScene(site, gameId, users.gm);
    const token = { name: "Гоблин", side: "enemies", size: "small", x: 2, y: 3, hidden: false, vision: null, character: null };
    assert.deepEqual((await patch(site, gameId, sceneId, users.gm, [["cells", "0,0", "floor"], ["edges", "h:0,0", "wall"]])).body, { version: 1 });
    assert.deepEqual((await patch(site, gameId, sceneId, users.gm, [["tokens", "t1", token], ["cells", "0,0", null]])).body, { version: 2 });
    const scene = await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie);
    assert.equal(scene.body.version, 2);
    assert.deepEqual([scene.body.scene.cells, scene.body.scene.edges, scene.body.scene.tokens], [{}, { "h:0,0": "wall" }, { t1: token }]);
  });

  test("a bad change is 400 and the scene does not change", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const gameId = await createGame(site, users.gm);
    const sceneId = await createScene(site, gameId, users.gm);
    await patch(site, gameId, sceneId, users.gm, FLOOR);
    const before = await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie);
    const bad: unknown[] = [
      undefined,
      "cells",
      [["cells", "0,0"]],
      [["cells", "0,0", "floor"], ["cells", "-0,1", "floor"]],
      [["cells", "1,1", "lava"], ["cells", "2,2", "plasma"]],
      [["walls", "h:0,0", "wall"]],
      [["settings", "name", "x".repeat(41)]],
      [["tokens", "t1", { name: "A", side: "enemies" }]],
    ];
    for (const change of bad) assertError(await patch(site, gameId, sceneId, users.gm, change), "scene.patch", JSON.stringify(change));
    assert.deepEqual((await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie)).body, before.body);
  });

  test("a scene over 2 MiB is refused and stays as it was", async () => {
    const { site, users } = await siteWith("admin", "gm");
    const gameId = await createGame(site, users.gm);
    const sceneId = await createScene(site, gameId, users.gm);
    // About 46 KB a mark, 20 marks a request: two requests fit in 2 MiB, the third does not.
    const pts = Array.from({ length: 2000 }, () => [-1234.5678, 1234.5678]);
    const marks = (from: number): unknown[] => Array.from({ length: 20 }, (_, i) => ["marks", `m${from + i}`, { color: "#c0392b", pts }]);
    assert.deepEqual((await patch(site, gameId, sceneId, users.gm, marks(0))).body, { version: 1 });
    assert.deepEqual((await patch(site, gameId, sceneId, users.gm, marks(20))).body, { version: 2 });
    assertError(await patch(site, gameId, sceneId, users.gm, marks(40)), "scene.tooLarge");
    const scene = await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, users.gm.cookie);
    assert.equal(scene.body.version, 2);
    assert.equal(Object.keys(scene.body.scene.marks).length, 40);
  });
});

describe("the change the board sends (client/src/app/api.ts)", () => {
  test("applied to the server's copy, it gives the board's scene after a change, an undo and a redo", () => {
    const scene = newScene();
    scene.cells["5,5"] = "grass";
    const server = structuredClone(scene);
    const history = newHistory();
    const last = (list: Patch[]): Patch => list[list.length - 1];

    // One stroke of several patches that paint a cell twice, erase one and draw a wall.
    beginChange(history);
    applyToChange(scene, history, [["cells", "0,0", "floor"], ["cells", "1,0", "floor"]]);
    applyToChange(scene, history, [["cells", "0,0", "lava"], ["cells", "5,5", null], ["edges", "h:1,0", "wall"]]);
    assert.equal(finishChange(history), true);
    const change = forwardPatch(scene, last(history.undo));
    assert.equal(change.length, 4, "each entry once");
    applyPatch(server, change);
    assert.deepEqual(server, scene);

    assert.equal(undo(scene, history), true);
    applyPatch(server, forwardPatch(scene, last(history.redo)));
    assert.deepEqual(server, scene);
    assert.deepEqual(scene.cells, { "5,5": "grass" });

    assert.equal(redo(scene, history), true);
    applyPatch(server, forwardPatch(scene, last(history.undo)));
    assert.deepEqual(server, scene);
  });
});
