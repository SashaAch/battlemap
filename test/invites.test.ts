// QR invites (plan 8.26, R43): an administrator's game invite as a registration code, and the links of an invite
// on the addresses of this computer. Through real HTTP on a free port of 127.0.0.1 with the data in a temporary
// folder; the rollback of a failed registration and the choice of addresses are checked on the modules directly.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { startServer } from "../server/app.ts";
import type { RunningServer } from "../server/app.ts";
import { Accounts, DAY_MS, LIMIT_WINDOW_MS, MAX_REGISTRATIONS_PER_ADDRESS, sha256 } from "../server/auth.ts";
import { Database } from "../server/db.ts";
import { ERRORS } from "../server/errors.ts";
import type { ErrorCode } from "../server/errors.ts";
import { inviteLinks } from "../server/network.ts";
import type { Interfaces } from "../server/network.ts";
import type { PasswordHasher } from "../server/passwords.ts";

// ---- a site in a temporary folder: registration closed, users made while it was open ----

interface Site {
  server: RunningServer;
  base: string;
  clock: { now: number };
}

interface Reply {
  status: number;
  body: any;
}

interface Person {
  id: number;
  cookie: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-invites-"));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

/** Registers without a session; the reply and the new session, if any. */
async function register(site: Site, login: string, code?: string, extra: object = {}): Promise<Reply & { cookie?: string }> {
  const response = await fetch(`${site.base}/api/auth/register`, {
    method: "POST",
    headers: { Origin: site.base, "Content-Type": "application/json" },
    body: JSON.stringify({ login, displayName: login.toUpperCase(), password: `${login}-password`, ...(code === undefined ? {} : { code }), ...extra }),
  });
  const text = await response.text();
  const cookie = response.headers.get("set-cookie")?.match(/^bm_session=[^;]*/)?.[0];
  return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie };
}

/**
 * A site whose first user "admin" is the administrator and the others ordinary users; registration is open
 * while they sign up and closed afterwards, so a newcomer needs a code.
 */
async function siteWith(...logins: string[]): Promise<{ site: Site; users: Record<string, Person> }> {
  const dir = tempDir();
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ openRegistration: true }));
  const clock = { now: Date.UTC(2026, 0, 1) };
  const server = await startServer({ dataDir: dir, host: "127.0.0.1", port: 0, now: () => clock.now, log: () => undefined });
  cleanups.push(() => server.close());
  const site: Site = { server, base: `http://127.0.0.1:${server.port}`, clock };
  const link = server.setupLink ?? "";
  const users: Record<string, Person> = {};
  for (const [index, login] of ["admin", ...logins].entries()) {
    const reply = await register(site, login, undefined, index === 0 ? { setup: link.slice(link.indexOf("#setup=") + 7) } : {});
    assert.equal(reply.status, 201, login);
    assert.ok(reply.cookie);
    users[login] = { id: reply.body.id, cookie: reply.cookie };
  }
  await setOpenRegistration(site, users.admin, false);
  return { site, users };
}

async function setOpenRegistration(site: Site, admin: Person, open: boolean): Promise<void> {
  assert.equal((await call(site, "PUT", "/api/admin/settings", admin.cookie, { openRegistration: open })).status, 200);
}

/** A game of `gm` with one scene, current and visible to players. */
async function gameOf(site: Site, gm: Person): Promise<{ gameId: number; sceneId: number }> {
  const game = await call(site, "POST", "/api/games", gm.cookie, { title: "Склеп", kind: "gm" });
  assert.equal(game.status, 201);
  const scene = await call(site, "POST", `/api/games/${game.body.id}/scenes`, gm.cookie, { name: "Зал" });
  assert.equal(scene.status, 201);
  assert.equal((await call(site, "PUT", `/api/games/${game.body.id}/scenes/${scene.body.id}`, gm.cookie, { visible: true })).status, 200);
  return { gameId: game.body.id, sceneId: scene.body.id };
}

async function invite(site: Site, gameId: number, gm: Person, maxUses = 5, days = 7): Promise<string> {
  const reply = await call(site, "POST", `/api/games/${gameId}/invites`, gm.cookie, { maxUses, days });
  assert.equal(reply.status, 201);
  return reply.body.code;
}

const memberIds = async (site: Site, gameId: number, gm: Person): Promise<number[]> =>
  (await call(site, "GET", `/api/games/${gameId}`, gm.cookie)).body.members.map((member: { id: number }) => member.id);

/** Whether an account with the login exists, from the administrator's list of users. */
async function loginTaken(site: Site, admin: Person, login: string): Promise<boolean> {
  const users = await call(site, "GET", "/api/admin/users", admin.cookie);
  return users.body.users.some((user: { login: string }) => user.login === login);
}

// ---- tests ----

describe("an administrator's game invite registers (R43)", () => {
  test("a newcomer registers by it, becomes a player of the game and sees its scene; each registration uses one entry", async () => {
    const { site, users } = await siteWith();
    const { gameId, sceneId } = await gameOf(site, users.admin);
    const code = await invite(site, gameId, users.admin, 2);

    const first = await register(site, "newbie", code);
    assert.equal(first.status, 201);
    assert.equal(first.body.gameId, gameId);
    assert.equal(first.body.role, "user");
    assert.ok(first.cookie);
    const game = await call(site, "GET", `/api/games/${gameId}`, first.cookie);
    assert.equal(game.status, 200);
    assert.equal(game.body.role, "player");
    assert.equal((await call(site, "GET", `/api/games/${gameId}/scenes/${sceneId}`, first.cookie)).status, 200);
    assert.ok((await memberIds(site, gameId, users.admin)).includes(first.body.id));

    assert.equal((await register(site, "second", code)).status, 201);
    // Both entries are used: the third is answered like an unknown code, as a used-up code was in stage 5.
    assertError(await register(site, "third", code), "auth.inviteInvalid");
    assert.equal(await loginTaken(site, users.admin, "third"), false);
  });

  test("a registration without an invite gets no game", async () => {
    const { site, users } = await siteWith();
    const registration = await call(site, "POST", "/api/admin/invites", users.admin.cookie, { maxUses: 1, days: 1 });
    const reply = await register(site, "newbie", registration.body.code);
    assert.equal(reply.status, 201);
    assert.equal(reply.body.gameId, null);
  });

  test("the invite of a master who is not an administrator is answered like an unknown code, even when expired", async () => {
    const { site, users } = await siteWith("master");
    const { gameId } = await gameOf(site, users.master);
    const code = await invite(site, gameId, users.master, 5, 1);
    const unknown = await register(site, "newbie", "abcdefghijkmnpqr");
    assertError(unknown, "auth.inviteInvalid");
    assert.deepEqual(await register(site, "newbie", code), unknown);
    site.clock.now += DAY_MS;
    assert.deepEqual(await register(site, "newbie", code), unknown, "expired: still no hint that the code exists");
    assert.equal(await loginTaken(site, users.admin, "newbie"), false);
    assert.deepEqual(await memberIds(site, gameId, users.master), [users.master.id]);
    // The same code still lets a user with an account in (stage 5).
    site.clock.now -= DAY_MS;
    assert.equal((await call(site, "POST", `/api/join/${code}`, users.admin.cookie)).status, 200);
  });

  test("an expired invite of an administrator is 410 and makes no account", async () => {
    const { site, users } = await siteWith();
    const { gameId } = await gameOf(site, users.admin);
    const code = await invite(site, gameId, users.admin, 5, 1);
    site.clock.now += DAY_MS;
    assertError(await register(site, "newbie", code), "invite.expired");
    assert.equal(await loginTaken(site, users.admin, "newbie"), false);
    assert.deepEqual(await memberIds(site, gameId, users.admin), [users.admin.id]);
  });

  test("an administrator who lost the role before the registration no longer registers anyone; the role back, it does again", async () => {
    const { site, users } = await siteWith("boss");
    const setRole = async (role: string): Promise<void> => {
      const reply = await call(site, "POST", "/api/admin/users", users.admin.cookie, { action: "setRole", id: users.boss.id, role });
      assert.equal(reply.status, 200);
    };
    await setRole("admin");
    const { gameId } = await gameOf(site, users.boss);
    const code = await invite(site, gameId, users.boss);
    await setRole("user");
    assertError(await register(site, "newbie", code), "auth.inviteInvalid");
    assert.equal(await loginTaken(site, users.admin, "newbie"), false);
    await setRole("admin");
    assert.equal((await register(site, "newbie", code)).status, 201);
  });

  test("a disabled administrator's invite does not register", async () => {
    const { site, users } = await siteWith("boss");
    assert.equal((await call(site, "POST", "/api/admin/users", users.admin.cookie, { action: "setRole", id: users.boss.id, role: "admin" })).status, 200);
    const { gameId } = await gameOf(site, users.boss);
    const code = await invite(site, gameId, users.boss);
    assert.equal((await call(site, "POST", "/api/admin/users", users.admin.cookie, { action: "setDisabled", id: users.boss.id, disabled: true })).status, 200);
    assertError(await register(site, "newbie", code), "auth.inviteInvalid");
  });

  test("the registration limit counts registrations by invite: the 11th attempt from one address is 429", async () => {
    const { site, users } = await siteWith();
    const { gameId } = await gameOf(site, users.admin);
    const code = await invite(site, gameId, users.admin, 20);
    for (let attempt = 1; attempt <= MAX_REGISTRATIONS_PER_ADDRESS; attempt++) {
      const reply = await register(site, `user_${attempt}`, attempt % 2 ? code : "wrongcode");
      assert.equal(reply.status, attempt % 2 ? 201 : 403, `attempt ${attempt}`);
    }
    assertError(await register(site, "user_eleven", code), "auth.tooManyRegistrations");
    site.clock.now += LIMIT_WINDOW_MS;
    assert.equal((await register(site, "user_eleven", code)).status, 201);
  });

  test("with open registration the invite is not used at registration; the user joins by it afterwards", async () => {
    const { site, users } = await siteWith();
    const { gameId } = await gameOf(site, users.admin);
    const code = await invite(site, gameId, users.admin, 1);
    await setOpenRegistration(site, users.admin, true);
    const reply = await register(site, "newbie", code);
    assert.equal(reply.status, 201);
    assert.equal(reply.body.gameId, null);
    assert.deepEqual(await memberIds(site, gameId, users.admin), [users.admin.id]);
    // The one entry is still there for the button.
    assert.equal((await call(site, "POST", `/api/join/${code}`, reply.cookie)).status, 200);
    assert.ok((await memberIds(site, gameId, users.admin)).includes(reply.body.id));
  });
});

describe("a registration that fails midway (R43)", () => {
  test("a failure after the account and the membership are written leaves neither, and the invite unused", async () => {
    const dir = tempDir();
    const db = new Database(path.join(dir, "battlemap.db"));
    cleanups.push(async () => db.close());
    // A fast hasher: the rollback, not scrypt, is under test.
    const hasher: PasswordHasher = {
      hash: async () => ({ passHash: new Uint8Array(32), passSalt: new Uint8Array(16), passParams: "test" }),
      matches: async () => true,
    };
    const now = Date.UTC(2026, 0, 1);
    const accounts = new Accounts(db, () => now, hasher);
    const { user: admin } = await accounts.register({ login: "admin", displayName: "A", password: "admin-password", setup: accounts.startSetup() ?? "" }, false, "127.0.0.1");
    const game = db.insertGame("Склеп", "gm", admin.id, admin.id, now);
    db.insertMember(game.id, admin.id, "gm", now);
    const code = "abcdefghijkmnpqr";
    db.insertInvite(sha256(code), "game", game.id, admin.id, now + DAY_MS, 1);

    const insertMember = db.insertMember.bind(db);
    db.insertMember = (...args) => {
      insertMember(...args);
      throw new Error("the disk is full");
    };
    await assert.rejects(accounts.register({ login: "newbie", displayName: "N", password: "newbie-password", code }, false, "127.0.0.1"), /disk is full/);
    assert.equal(db.findUserByLogin("newbie"), undefined);
    assert.deepEqual(db.listMembers(game.id).map((member) => member.userId), [admin.id]);
    assert.equal(db.findInvite(sha256(code))?.uses, 0);

    db.insertMember = insertMember;
    const registered = await accounts.register({ login: "newbie", displayName: "N", password: "newbie-password", code }, false, "127.0.0.1");
    assert.equal(registered.gameId, game.id);
    assert.equal(db.findMemberRole(game.id, registered.user.id), "player");
  });
});

describe("links of an invite (plan 8.26)", () => {
  const entry = (address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo =>
    family === "IPv4"
      ? { address, family, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }
      : { address, family, internal, netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", cidr: null, scopeid: 0 };

  // A computer like the customer's: WSL, Hyper-V and a VPN next to the home Wi-Fi.
  const interfaces: Interfaces = {
    "Loopback Pseudo-Interface 1": [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
    "vEthernet (WSL)": [entry("172.20.48.1", "IPv4"), entry("fe80::1234", "IPv6")],
    "VPN": [entry("100.64.1.2", "IPv4")],
    "vEthernet (Default Switch)": [entry("10.5.0.1", "IPv4")],
    "Wi-Fi": [entry("192.168.0.44", "IPv4"), entry("fd00::44", "IPv6")],
  };
  const links = (listenHost: string | undefined, pageHost: string | undefined) =>
    inviteLinks({ listenHost, port: 8080, pageHost, secure: false, fragment: "join=abc", interfaces });

  test("listening on all addresses: every network address but loopback, home networks first, with the adapter", () => {
    assert.deepEqual(links(undefined, "127.0.0.1:8080"), [
      { url: "http://192.168.0.44:8080/#join=abc", adapter: "Wi-Fi" },
      { url: "http://10.5.0.1:8080/#join=abc", adapter: "vEthernet (Default Switch)" },
      { url: "http://172.20.48.1:8080/#join=abc", adapter: "vEthernet (WSL)" },
      { url: "http://100.64.1.2:8080/#join=abc", adapter: "VPN" },
      { url: "http://[fd00::44]:8080/#join=abc", adapter: "Wi-Fi" },
    ]);
    assert.deepEqual(links("0.0.0.0", "localhost:8080"), links(undefined, "[::1]:8080"));
  });

  test("the page's own address comes first, once, unless it is loopback", () => {
    const fromVpn = links(undefined, "100.64.1.2:8080");
    assert.deepEqual(fromVpn[0], { url: "http://100.64.1.2:8080/#join=abc", adapter: "VPN" });
    assert.equal(fromVpn.length, 5);
    assert.equal(fromVpn.filter(({ url }) => url.includes("100.64.1.2")).length, 1);
    // A name from allowedHosts, or a port a router forwards, is a link of its own.
    assert.deepEqual(links(undefined, "Battlemap.Home.:80")[0], { url: "http://battlemap.home:80/#join=abc", adapter: null });
    assert.deepEqual(links(undefined, "192.168.0.44:9000").slice(0, 2).map(({ url }) => url), [
      "http://192.168.0.44:9000/#join=abc",
      "http://192.168.0.44:8080/#join=abc",
    ]);
    for (const loopback of ["127.0.0.1:8080", "localhost:8080", "[::1]:8080", "LOCALHOST", undefined]) {
      assert.equal(links(undefined, loopback).length, 5, String(loopback));
    }
    // A Host that is not a plain name or address with a port adds nothing.
    assert.equal(links(undefined, "[::1]x.example").length, 5);
  });

  test("listening on one address: that address only, and nothing when it is loopback", () => {
    assert.deepEqual(links("192.168.0.44", "127.0.0.1:8080"), [{ url: "http://192.168.0.44:8080/#join=abc", adapter: "Wi-Fi" }]);
    assert.deepEqual(links("127.0.0.1", "127.0.0.1:8080"), []);
    assert.deepEqual(links("127.0.0.1", "battlemap.home:8080"), [{ url: "http://battlemap.home:8080/#join=abc", adapter: null }]);
  });

  test("the reply to a new invite carries the links, none of them loopback", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ openRegistration: true, allowedHosts: ["battlemap.home"] }));
    const clock = { now: Date.UTC(2026, 0, 1) };
    const server = await startServer({ dataDir: dir, host: "127.0.0.1", port: 0, now: () => clock.now, log: () => undefined });
    cleanups.push(() => server.close());
    const site: Site = { server, base: `http://127.0.0.1:${server.port}`, clock };
    const link = server.setupLink ?? "";
    const admin = await register(site, "admin", undefined, { setup: link.slice(link.indexOf("#setup=") + 7) });
    assert.ok(admin.cookie);
    const { gameId } = await gameOf(site, { id: admin.body.id, cookie: admin.cookie });

    const fromLoopback = await call(site, "POST", `/api/games/${gameId}/invites`, admin.cookie, { maxUses: 1, days: 1 });
    assert.equal(fromLoopback.status, 201);
    // The server listens on 127.0.0.1 only and the page is on it: no link a phone could open.
    assert.deepEqual(fromLoopback.body.links, []);

    // The page opened by a name of allowedHosts: that name is the link.
    const host = `battlemap.home:${server.port}`;
    const reply = await new Promise<Reply>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path: `/api/games/${gameId}/invites`,
        headers: { Host: host, Origin: `http://${host}`, "Content-Type": "application/json", Cookie: admin.cookie },
      });
      request.on("response", (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ maxUses: 1, days: 1 }));
    });
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body.links, [{ url: `http://${host}/#join=${reply.body.code}`, adapter: null }]);
  });

  test("a player still cannot make an invite, links or not", async () => {
    const { site, users } = await siteWith("pat");
    const { gameId } = await gameOf(site, users.admin);
    const code = await invite(site, gameId, users.admin);
    assert.equal((await call(site, "POST", `/api/join/${code}`, users.pat.cookie)).status, 200);
    assertError(await call(site, "POST", `/api/games/${gameId}/invites`, users.pat.cookie, { maxUses: 1, days: 1 }), "auth.forbidden");
  });
});
