// Accounts, sessions and the server's security rules (plan 5.10, 6.2, 6.4, 8.4), through real HTTP
// on a free port of 127.0.0.1 with the data in a temporary folder.

import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";

import { CLIENT_ERRORS } from "../client/src/app/api.ts";
import { en } from "../client/src/i18n/en.ts";
import { ru } from "../client/src/i18n/ru.ts";
import { startServer } from "../server/app.ts";
import type { RunningServer } from "../server/app.ts";
import {
  Accounts,
  DAY_MS,
  LIMIT_WINDOW_MS,
  MAX_FAILURES_PER_ADDRESS,
  MAX_FAILURES_PER_LOGIN,
  MAX_FAILURES_PER_LOGIN_AND_ADDRESS,
  MAX_REGISTRATIONS_PER_ADDRESS,
  SESSION_LIFETIME_MS,
} from "../server/auth.ts";
import { Database } from "../server/db.ts";
import { addressKey, AttemptLimiter } from "../server/limits.ts";
import { scryptHasher } from "../server/passwords.ts";
import type { PasswordHasher } from "../server/passwords.ts";
import { siteLinks } from "../server/network.ts";
import { ApiError, ERRORS } from "../server/errors.ts";
import type { ErrorCode } from "../server/errors.ts";

const ADMIN = { login: "admin", displayName: "Мастер", password: "admin-password" };

// ---- a site in a temporary folder ----

interface Site {
  dir: string;
  server: RunningServer;
  base: string;
  clock: { now: number };
  log: string[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(dir: string, clock: { now: number }): Promise<Site> {
  const log: string[] = [];
  const server = await startServer({ dataDir: dir, host: "127.0.0.1", port: 0, now: () => clock.now, log: (line) => log.push(line) });
  return { dir, server, base: `http://127.0.0.1:${server.port}`, clock, log };
}

/** `settings`, when given, is written to settings.json before the first start. */
async function newSite(settings?: object): Promise<Site> {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-auth-"));
  if (settings) writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  const site = await start(dir, { now: Date.UTC(2026, 0, 1) });
  cleanups.push(async () => {
    await site.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return site;
}

/** Stops the site and starts it again on the same data; the new server is closed by the same cleanup. */
async function restart(site: Site): Promise<void> {
  await site.server.close();
  const again = await start(site.dir, site.clock);
  site.server = again.server;
  site.base = again.base;
  site.log = again.log;
}

interface Reply {
  status: number;
  body: any;
  /** The session cookie as `bm_session=...`, when the response set one. */
  cookie?: string;
  setCookie: string | null;
  headers: Headers;
}

interface Options {
  body?: unknown;
  cookie?: string;
  /** null leaves the header out. */
  origin?: string | null;
  contentType?: string | null;
}

async function call(site: Site, method: string, url: string, options: Options = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? site.base : options.origin;
  if (origin !== null) headers.Origin = origin;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (method !== "GET" && contentType !== null) headers["Content-Type"] = contentType;
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await fetch(site.base + url, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
  const text = await response.text();
  const setCookie = response.headers.get("set-cookie");
  const session = setCookie?.match(/^bm_session=([^;]*)/)?.[1];
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    cookie: session ? `bm_session=${session}` : undefined,
    setCookie,
    headers: response.headers,
  };
}

/** The reply is the error `code` with the status the server keeps for it; only api/me adds a field to its 401. */
function assertError(reply: Reply, code: ErrorCode): void {
  const { error, ...rest } = reply.body ?? {};
  assert.deepEqual({ status: reply.status, error }, { status: ERRORS[code], error: code });
  const allowed = code === "auth.required" ? ["openRegistration"] : [];
  for (const key of Object.keys(rest)) assert.ok(allowed.includes(key), `unexpected field ${key}`);
}

function setupToken(site: Site): string {
  const link = site.server.setupLink;
  assert.ok(link, "the server has a setup link");
  return link.slice(link.indexOf("#setup=") + "#setup=".length);
}

/** A site with its first administrator, created through the setup link. */
async function siteWithAdmin(): Promise<{ site: Site; admin: string }> {
  const site = await newSite();
  const reply = await call(site, "POST", "/api/auth/register", { body: { ...ADMIN, setup: setupToken(site) } });
  assert.equal(reply.status, 201);
  assert.ok(reply.cookie);
  return { site, admin: reply.cookie };
}

async function createUser(site: Site, admin: string, login: string, role = "user"): Promise<{ id: number; password: string }> {
  const reply = await call(site, "POST", "/api/admin/users", { cookie: admin, body: { action: "create", login, displayName: login, role } });
  assert.equal(reply.status, 201);
  return { id: reply.body.user.id, password: reply.body.password };
}

async function login(site: Site, name: string, password: string): Promise<Reply> {
  return call(site, "POST", "/api/auth/login", { body: { login: name, password } });
}

/** A user who has already replaced the temporary password; returns their session. */
async function readyUser(site: Site, admin: string, name: string, password = `${name}-password`): Promise<{ id: number; cookie: string }> {
  const created = await createUser(site, admin, name);
  const signedIn = await login(site, name, created.password);
  assert.ok(signedIn.cookie);
  const changed = await call(site, "POST", "/api/me/password", {
    cookie: signedIn.cookie,
    body: { currentPassword: created.password, newPassword: password },
  });
  assert.equal(changed.status, 200);
  return { id: created.id, cookie: signedIn.cookie };
}

interface RawReply {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * A raw request: the path and headers are sent exactly as given. The body is written as `chunks`;
 * with a declared length or chunked encoding the request is not ended, so the server must answer on its own.
 */
function rawRequest(site: Site, method: string, target: string, headers: Record<string, string> = {}, chunks: string[] = []): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: site.server.port, method, path: target, headers });
    request.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, text, headers: response.headers });
      });
    });
    request.on("error", reject);
    const write = (index: number): void => {
      if (index >= chunks.length) {
        if (!headers["Transfer-Encoding"] && !headers["Content-Length"]) request.end();
        return;
      }
      request.write(chunks[index], () => setTimeout(() => write(index + 1), 20));
    };
    request.flushHeaders();
    write(0);
  });
}

// ---- tests ----

describe("first start", () => {
  test("settings.json is created and a one-time administrator link is printed", async () => {
    const site = await newSite();
    const settings = JSON.parse(readFileSync(path.join(site.dir, "settings.json"), "utf8"));
    assert.deepEqual(settings, { port: 8080, openRegistration: false, allowedHosts: [] });
    assert.ok(site.server.setupLink?.startsWith(`${site.base}/#setup=`));
    assert.ok(site.log.includes(site.server.setupLink ?? ""), "the link is printed");
    assert.ok(site.log.some((line) => line.includes("HTTP") && line.includes("открытым текстом")), "the HTTP warning is printed");
  });

  test("without users only the setup link registers, and only once", async () => {
    const site = await newSite();
    const token = setupToken(site);
    const plain = await call(site, "POST", "/api/auth/register", { body: { login: "early", displayName: "E", password: "password1" } });
    assertError(plain, "auth.inviteInvalid");
    assertError(await call(site, "POST", "/api/auth/register", { body: { ...ADMIN, setup: "x".repeat(43) } }), "auth.setupInvalid");

    const first = await call(site, "POST", "/api/auth/register", { body: { ...ADMIN, setup: token } });
    assert.equal(first.status, 201);
    assert.equal(first.body.role, "admin");
    const again = await call(site, "POST", "/api/auth/register", { body: { login: "second", displayName: "S", password: "password1", setup: token } });
    assertError(again, "auth.setupInvalid");
  });

  test("a restart without users prints a new link; with users there is none", async () => {
    const site = await newSite();
    const before = site.server.setupLink;
    await restart(site);
    assert.ok(site.server.setupLink);
    assert.notEqual(site.server.setupLink, before);

    await call(site, "POST", "/api/auth/register", { body: { ...ADMIN, setup: setupToken(site) } });
    await restart(site);
    assert.equal(site.server.setupLink, null);
    assert.ok(!site.log.some((line) => line.includes("#setup=")));
  });
});

describe("registration, sign-in, api/me", () => {
  test("registration by a code from the administrator, then sign-in and api/me", async () => {
    const { site, admin } = await siteWithAdmin();
    const invite = await call(site, "POST", "/api/admin/invites", { cookie: admin, body: { maxUses: 1, days: 7 } });
    assert.equal(invite.status, 201);
    assert.deepEqual({ ...invite.body, code: undefined }, { code: undefined, expiresAt: site.clock.now + 7 * DAY_MS, maxUses: 1 });

    const player = { login: "player_1", displayName: "  Игрок  ", password: "correct horse" };
    assertError(await call(site, "POST", "/api/auth/register", { body: player }), "auth.inviteInvalid");
    assertError(await call(site, "POST", "/api/auth/register", { body: { ...player, code: "wrong" } }), "auth.inviteInvalid");

    const registered = await call(site, "POST", "/api/auth/register", { body: { ...player, code: invite.body.code } });
    assert.equal(registered.status, 201);
    assert.match(registered.setCookie ?? "", /^bm_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
    assert.equal(registered.body.displayName, "Игрок");

    const reused = await call(site, "POST", "/api/auth/register", { body: { ...player, login: "player_2", code: invite.body.code } });
    assertError(reused, "auth.inviteInvalid");

    const signedIn = await login(site, "player_1", "correct horse");
    assert.equal(signedIn.status, 200);
    const me = await call(site, "GET", "/api/me", { cookie: signedIn.cookie });
    assert.equal(me.status, 200);
    assert.deepEqual(
      { login: me.body.login, displayName: me.body.displayName, role: me.body.role, mustChangePassword: me.body.mustChangePassword, settings: me.body.settings },
      { login: "player_1", displayName: "Игрок", role: "user", mustChangePassword: false, settings: {} },
    );
    assert.equal("passHash" in me.body || "pass_hash" in me.body, false);
  });

  test("an expired code does not register", async () => {
    const { site, admin } = await siteWithAdmin();
    const invite = await call(site, "POST", "/api/admin/invites", { cookie: admin, body: { maxUses: 5, days: 2 } });
    site.clock.now += 2 * DAY_MS;
    const reply = await call(site, "POST", "/api/auth/register", { body: { login: "late", displayName: "L", password: "password1", code: invite.body.code } });
    assertError(reply, "auth.inviteInvalid");
  });

  test("open registration needs no code; the login must be free and well-formed", async () => {
    const { site, admin } = await siteWithAdmin();
    assert.deepEqual((await call(site, "GET", "/api/me")).body, { error: "auth.required", openRegistration: false });

    const turnedOn = await call(site, "PUT", "/api/admin/settings", { cookie: admin, body: { openRegistration: true } });
    assert.deepEqual(turnedOn.body, { openRegistration: true });
    assert.equal(JSON.parse(readFileSync(path.join(site.dir, "settings.json"), "utf8")).openRegistration, true);
    assert.deepEqual((await call(site, "GET", "/api/me")).body, { error: "auth.required", openRegistration: true });

    assert.equal((await call(site, "POST", "/api/auth/register", { body: { login: "free", displayName: "F", password: "password1" } })).status, 201);
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "free", displayName: "F", password: "password1" } }), "login.taken");
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "Free", displayName: "F", password: "password1" } }), "login.format");
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "ab", displayName: "F", password: "password1" } }), "login.format");
    site.clock.now += LIMIT_WINDOW_MS; // stays under the limit on registrations per address
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "x".repeat(25), displayName: "F", password: "password1" } }), "login.format");
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "newbie", displayName: "   ", password: "password1" } }), "name.format");
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "newbie", displayName: "я".repeat(41), password: "password1" } }), "name.format");
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "newbie", displayName: "N", password: "seven77" } }), "password.format");
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "newbie", displayName: "N", password: "p".repeat(201) } }), "password.format");
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "newbie", displayName: 5, password: "password1" } }), "request.format");
    assert.equal((await call(site, "POST", "/api/auth/register", { body: { login: "newbie", displayName: "я".repeat(40), password: "p".repeat(200) } })).status, 201);
  });

  test("a wrong password and an unknown login get the same 401", async () => {
    const { site } = await siteWithAdmin();
    const wrongPassword = await login(site, "admin", "not-the-password");
    const unknownLogin = await login(site, "nobody", "not-the-password");
    assertError(wrongPassword, "auth.invalid");
    assertError(unknownLogin, "auth.invalid");
    assert.equal(wrongPassword.cookie, undefined);
  });
});

/** Accounts on a database of their own with a clock the test moves; the first administrator exists. */
async function directAccounts(hasher: PasswordHasher = scryptHasher): Promise<{ db: Database; accounts: Accounts; clock: { now: number } }> {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-auth-"));
  const db = new Database(path.join(dir, "battlemap.db"));
  cleanups.push(async () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: Date.UTC(2026, 0, 1) };
  const accounts = new Accounts(db, () => clock.now, hasher);
  await accounts.register({ ...ADMIN, setup: accounts.startSetup() ?? "" }, false, "127.0.0.1");
  return { db, accounts, clock };
}

/**
 * The real hasher, except that the next password check, once computed, waits for the test:
 * whatever the test does meanwhile happens between the check and what follows it.
 */
function pausingHasher() {
  let pending: { reached: () => void; go: Promise<void> } | null = null;
  const hasher: PasswordHasher = {
    hash: scryptHasher.hash,
    async matches(password, stored) {
      const result = await scryptHasher.matches(password, stored);
      const pause = pending;
      pending = null;
      if (pause) {
        pause.reached();
        await pause.go;
      }
      return result;
    },
  };
  const pauseNext = () => {
    let reached = (): void => undefined;
    let go = (): void => undefined;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    pending = { reached, go: new Promise<void>((resolve) => (go = resolve)) };
    return { reached: reachedPromise, go };
  };
  return { hasher, pauseNext };
}

/** "ok", or the error code the promise failed with. */
const outcome = (promise: Promise<unknown>): Promise<string> => promise.then(() => "ok", (error: ApiError) => error.code);

describe("password guessing (R39)", () => {
  test("per address: 10 failures are checked, the 11th attempt in 15 minutes gets 429 even with the right password", async () => {
    const { site } = await siteWithAdmin();
    for (let attempt = 1; attempt <= MAX_FAILURES_PER_ADDRESS; attempt++) {
      // Different logins: the address limit alone must stop it.
      assertError(await login(site, `guess_${attempt}`, "wrong-password"), "auth.invalid");
    }
    assertError(await login(site, "admin", ADMIN.password), "auth.tooManyAttempts");

    site.clock.now += LIMIT_WINDOW_MS - 1;
    assertError(await login(site, "admin", ADMIN.password), "auth.tooManyAttempts");
    site.clock.now += 1;
    assert.equal((await login(site, "admin", ADMIN.password)).status, 200);
  });

  test("per login and address: 10 failures close the login for that address only", async () => {
    const { accounts, clock } = await directAccounts();
    for (let attempt = 1; attempt <= MAX_FAILURES_PER_LOGIN_AND_ADDRESS; attempt++) {
      assert.equal(await outcome(accounts.login("admin", "wrong-password", "10.0.0.1")), "auth.invalid", `attempt ${attempt}`);
    }
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, "10.0.0.1")), "auth.tooManyAttempts");
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, "10.0.0.2")), "ok", "another address still signs in");
    clock.now += LIMIT_WINDOW_MS;
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, "10.0.0.1")), "ok");
  });

  test("per login from all addresses: 100 failures are checked, the 101st attempt gets 429 from any address", async () => {
    const { accounts, clock } = await directAccounts();
    const address = (n: number): string => `10.${Math.floor(n / 200)}.${n % 200}.1`;
    const first = await Promise.all(
      Array.from({ length: MAX_FAILURES_PER_LOGIN - 1 }, (_, n) => outcome(accounts.login("admin", "wrong-password", address(n)))),
    );
    assert.deepEqual(new Set(first), new Set(["auth.invalid"]));
    assert.equal(await outcome(accounts.login("admin", "wrong-password", address(500))), "auth.invalid", "the 100th failure");
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, address(501))), "auth.tooManyAttempts", "the 101st attempt");
    assert.equal(await outcome(accounts.login("other", "wrong-password", address(501))), "auth.invalid", "other logins are open");

    clock.now += LIMIT_WINDOW_MS;
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, address(501))), "ok");
  });

  test("a wrong current password when changing it counts the same: the 11th attempt gets 429", async () => {
    const { site, admin } = await siteWithAdmin();
    const change = (currentPassword: string) =>
      call(site, "POST", "/api/me/password", { cookie: admin, body: { currentPassword, newPassword: "a-brand-new-password" } });
    for (let attempt = 1; attempt <= MAX_FAILURES_PER_LOGIN_AND_ADDRESS; attempt++) {
      assertError(await change("wrong-password"), "password.wrong");
    }
    assertError(await change(ADMIN.password), "auth.tooManyAttempts");
    assertError(await login(site, "admin", ADMIN.password), "auth.tooManyAttempts");
  });

  test("parallel attempts cannot slip past the limit", async () => {
    const { site } = await siteWithAdmin();
    const replies = await Promise.all(Array.from({ length: 15 }, () => login(site, "admin", "wrong-password")));
    const statuses = replies.map((reply) => reply.status).sort();
    assert.deepEqual(statuses, [...Array(MAX_FAILURES_PER_ADDRESS).fill(401), ...Array(5).fill(429)]);
  });

  test("IPv6 addresses count by their /64 network, IPv4-mapped addresses as IPv4", async () => {
    assert.equal(addressKey("2001:db8:1:2::5"), "2001:db8:1:2::/64");
    assert.equal(addressKey("2001:0DB8:0001:0002:ffff:1:2:3"), "2001:db8:1:2::/64");
    assert.equal(addressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
    assert.equal(addressKey("::1"), "0:0:0:0::/64");
    assert.equal(addressKey("64:ff9b::10.0.0.1"), "64:ff9b:0:0::/64");
    assert.equal(addressKey("::ffff:192.168.1.5"), "192.168.1.5");
    assert.equal(addressKey("192.168.1.5"), "192.168.1.5");

    const { accounts } = await directAccounts();
    for (let attempt = 1; attempt <= MAX_FAILURES_PER_ADDRESS; attempt++) {
      assert.equal(await outcome(accounts.login(`guess_${attempt}`, "wrong-password", `2001:db8:1:2::${attempt}`)), "auth.invalid");
      assert.equal(await outcome(accounts.login(`guess_${attempt}`, "wrong-password", "::ffff:10.1.1.1")), "auth.invalid");
    }
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, "2001:db8:1:2:ffff::9")), "auth.tooManyAttempts");
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, "10.1.1.1")), "auth.tooManyAttempts");
    assert.equal(await outcome(accounts.login("admin", ADMIN.password, "2001:db8:1:3::1")), "ok", "the next /64 is another network");
  });

  test("a hash made with older scrypt parameters still signs in and is made again with the current ones", async () => {
    const { db, accounts } = await directAccounts();
    const salt = Buffer.alloc(16, 7);
    db.insertUser({
      login: "old_timer",
      displayName: "Old",
      passHash: scryptSync("old-password", salt, 64, { N: 2 ** 14, r: 8, p: 1 }),
      passSalt: salt,
      passParams: "scrypt:16384:8:1",
      role: "user",
      mustChangePassword: false,
      createdAt: 0,
    });
    assert.equal(await outcome(accounts.login("old_timer", "old-password", "10.0.0.1")), "ok");
    assert.equal(db.findUserByLogin("old_timer")?.passParams, "scrypt:32768:8:1");
    assert.equal(await outcome(accounts.login("old_timer", "old-password", "10.0.0.1")), "ok");
  });
});

describe("a password changing while it is checked", () => {
  async function anna() {
    const { hasher, pauseNext } = pausingHasher();
    const { db, accounts } = await directAccounts(hasher);
    const { user } = await accounts.register({ login: "anna", displayName: "Anna", password: "anna-password" }, true, "10.0.0.9");
    const own = accounts.authenticate((await accounts.login("anna", "anna-password", "10.0.0.2")).token);
    assert.ok(own);
    const admin = db.findUserByLogin("admin");
    assert.ok(admin);
    return { db, accounts, pauseNext, user, own, admin };
  }

  test("a sign-in checked before a password change makes no session", async () => {
    const { accounts, pauseNext, own } = await anna();
    const pause = pauseNext();
    const racing = outcome(accounts.login("anna", "anna-password", "10.0.0.3"));
    await pause.reached;
    await accounts.changePassword(own, "anna-password", "anna-new-password", "10.0.0.2");
    pause.go();
    assert.equal(await racing, "auth.invalid");
    assert.ok(accounts.authenticate(own.token), "the session that changed the password stays");
  });

  test("a sign-in checked before a reset by the administrator makes no session", async () => {
    const { accounts, pauseNext, user, admin } = await anna();
    const pause = pauseNext();
    const racing = outcome(accounts.login("anna", "anna-password", "10.0.0.3"));
    await pause.reached;
    await accounts.resetPassword(admin, user.id);
    pause.go();
    assert.equal(await racing, "auth.invalid");
  });

  test("a sign-in checked before the account is disabled makes no session", async () => {
    const { accounts, pauseNext, user, admin } = await anna();
    const pause = pauseNext();
    const racing = outcome(accounts.login("anna", "anna-password", "10.0.0.3"));
    await pause.reached;
    accounts.setDisabled(admin, user.id, true);
    pause.go();
    assert.equal(await racing, "auth.invalid");
  });

  test("a password change checked before a reset by the administrator is refused", async () => {
    const { accounts, pauseNext, user, own, admin } = await anna();
    const second = accounts.authenticate((await accounts.login("anna", "anna-password", "10.0.0.4")).token);
    assert.ok(second);
    const pause = pauseNext();
    const racing = outcome(accounts.changePassword(second, "anna-password", "anna-new-password", "10.0.0.4"));
    await pause.reached;
    const reset = await accounts.resetPassword(admin, user.id);
    pause.go();
    assert.equal(await racing, "password.wrong");
    assert.equal(accounts.authenticate(own.token), null);
    assert.equal(await outcome(accounts.login("anna", reset.password, "10.0.0.5")), "ok", "the reset password is the one that works");
  });

  test("a session made under an older password version is not valid", async () => {
    const { db, accounts, user, own } = await anna();
    const current = db.findUserById(user.id);
    assert.ok(current);
    // A new password written without going through Accounts, as if another request did it right after the check.
    db.setPassword(user.id, current, false);
    assert.equal(accounts.authenticate(own.token), null);
  });
});

describe("registration limits and codes (R38, R39)", () => {
  test("registration by code or open registration: the 11th attempt in 15 minutes from one address gets 429", async () => {
    const { site, admin } = await siteWithAdmin();
    await call(site, "PUT", "/api/admin/settings", { cookie: admin, body: { openRegistration: true } });
    const register = (loginName: string) => call(site, "POST", "/api/auth/register", { body: { login: loginName, displayName: "N", password: "password1" } });
    for (let attempt = 1; attempt <= MAX_REGISTRATIONS_PER_ADDRESS; attempt++) {
      // Successful and failed registrations count alike.
      const reply = await register(attempt % 2 ? `user_${attempt}` : "Bad Login");
      assert.equal(reply.status, attempt % 2 ? 201 : 400, `attempt ${attempt}`);
    }
    assertError(await register("user_eleven"), "auth.tooManyRegistrations");
    site.clock.now += LIMIT_WINDOW_MS;
    assert.equal((await register("user_eleven")).status, 201);
  });

  test("a code is used as many times as the administrator allows, also by parallel requests", async () => {
    const { site, admin } = await siteWithAdmin();
    const invite = await call(site, "POST", "/api/admin/invites", { cookie: admin, body: { maxUses: 3, days: 1 } });
    const replies = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        call(site, "POST", "/api/auth/register", { body: { login: `racer_${n}`, displayName: "R", password: "password1", code: invite.body.code } }),
      ),
    );
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 201, 201, 403, 403, 403]);
    for (const reply of replies.filter((entry) => entry.status === 403)) assertError(reply, "auth.inviteInvalid");
    const users = await call(site, "GET", "/api/admin/users", { cookie: admin });
    assert.equal(users.body.users.length, 4);
  });

  test("uses and days of a code are whole numbers within bounds", async () => {
    const { site, admin } = await siteWithAdmin();
    const invite = (body: object) => call(site, "POST", "/api/admin/invites", { cookie: admin, body });
    for (const body of [{}, { maxUses: 1 }, { days: 1 }, { maxUses: 0, days: 1 }, { maxUses: 1001, days: 1 }, { maxUses: 1.5, days: 1 }, { maxUses: "3", days: 1 }, { maxUses: 1, days: 0 }, { maxUses: 1, days: 366 }]) {
      assertError(await invite(body), "request.format");
    }
    const longest = await invite({ maxUses: 1000, days: 365 });
    assert.equal(longest.status, 201);
    assert.equal(longest.body.expiresAt, site.clock.now + 365 * DAY_MS);
  });

  test("with openRegistration in settings.json and no users, only the setup link registers", async () => {
    const site = await newSite({ openRegistration: true });
    assert.deepEqual((await call(site, "GET", "/api/me")).body, { error: "auth.required", openRegistration: false });
    assertError(await call(site, "POST", "/api/auth/register", { body: { login: "early", displayName: "E", password: "password1" } }), "auth.inviteInvalid");
    assert.equal((await call(site, "POST", "/api/auth/register", { body: { ...ADMIN, setup: setupToken(site) } })).status, 201);
    assert.equal((await call(site, "POST", "/api/auth/register", { body: { login: "later", displayName: "L", password: "password1" } })).status, 201);
  });

  test("the setup link makes one administrator, also under parallel requests", async () => {
    const site = await newSite();
    const token = setupToken(site);
    const replies = await Promise.all(
      ["first_admin", "second_admin"].map((name) => call(site, "POST", "/api/auth/register", { body: { login: name, displayName: name, password: "password1", setup: token } })),
    );
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 403]);
    assertError(replies.find((reply) => reply.status === 403) as Reply, "auth.setupInvalid");
  });
});

describe("roles (R38)", () => {
  test("an administrator makes another user an administrator and takes it back, but not from themselves", async () => {
    const { site, admin } = await siteWithAdmin();
    const user = await readyUser(site, admin, "erin");
    const setRole = (id: number, role: unknown, cookie = admin) => call(site, "POST", "/api/admin/users", { cookie, body: { action: "setRole", id, role } });

    assertError(await call(site, "GET", "/api/admin/users", { cookie: user.cookie }), "auth.forbidden");
    assert.equal((await setRole(user.id, "admin")).body.user.role, "admin");
    assert.equal((await call(site, "GET", "/api/admin/users", { cookie: user.cookie })).status, 200, "the new role works at once");

    const me = await call(site, "GET", "/api/me", { cookie: admin });
    assertError(await setRole(me.body.id, "user"), "admin.self");
    assertError(await setRole(user.id, "root"), "request.format");
    assertError(await setRole(999, "user"), "user.notFound");

    assert.equal((await setRole(user.id, "user")).body.user.role, "user");
    assertError(await call(site, "GET", "/api/admin/users", { cookie: user.cookie }), "auth.forbidden");
  });
});

describe("the attempt limiter", () => {
  test("it keeps at most maxKeys keys, a new key beyond that is refused, and it sweeps at most every 10 seconds", () => {
    const limiter = new AttemptLimiter(2, 1000, 3);
    for (const key of ["a", "b", "c"]) assert.equal(limiter.take(key, 0), true, key);
    assert.equal(limiter.take("d", 0), false, "the table is full: a new key counts as used up");
    assert.equal(limiter.take("a", 0), true, "known keys still count normally");
    assert.equal(limiter.take("a", 0), false);
    assert.equal(limiter.take("d", 9_999), false, "expired keys are not swept before 10 seconds");
    assert.equal(limiter.take("d", 10_000), true, "after the sweep there is room again");
  });
});

describe("Host names (DNS rebinding)", () => {
  test("a request with a foreign Host is refused, even with a matching Origin", async () => {
    const { site } = await siteWithAdmin();
    const port = site.server.port;
    // After the brackets of IPv6 only a port may follow.
    const hosts = [`evil.example:${port}`, `evil.example`, `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`, "[::1]x", `[::1]evil.example:${port}`];
    for (const host of hosts) {
      const page = await rawRequest(site, "GET", "/", { Host: host });
      assert.deepEqual({ status: page.status, text: page.text }, { status: 403, text: '{"error":"request.host"}' }, host);
      const body = JSON.stringify({ login: "admin", password: ADMIN.password });
      const signIn = await rawRequest(
        site,
        "POST",
        "/api/auth/login",
        { Host: host, Origin: `http://${host}`, "Content-Type": "application/json", "Content-Length": String(body.length) },
        [body],
      );
      assert.deepEqual({ status: signIn.status, text: signIn.text }, { status: 403, text: '{"error":"request.host"}' }, host);
    }
  });

  test("localhost, 127.0.0.1, [::1] and allowedHosts from settings.json are accepted", async () => {
    const site = await newSite({ allowedHosts: ["Battlemap.Example"] });
    const port = site.server.port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `battlemap.example:${port}`, `BATTLEMAP.example`]) {
      assert.equal((await rawRequest(site, "GET", "/api/me", { Host: host })).status, 401, host);
    }
    const body = JSON.stringify({ login: "nobody", password: "wrong-password" });
    const signIn = await rawRequest(
      site,
      "POST",
      "/api/auth/login",
      { Host: `battlemap.example:${port}`, Origin: `http://battlemap.example:${port}`, "Content-Type": "application/json", "Content-Length": String(body.length) },
      [body],
    );
    assert.equal(signIn.status, 401, "the Origin is compared with the allowed Host");
  });

  test("allowedHosts are read like a Host header: case, a final dot, a port, IPv6 brackets", async () => {
    const site = await newSite({ allowedHosts: ["Game.Example.org.:8080", "2001:DB8::7", "[2001:db8::8]:9000"] });
    const accepted = ["game.example.org:8080", "GAME.EXAMPLE.ORG", "game.example.org.:1234", "[2001:db8::7]:8080", "[2001:db8::8]"];
    for (const host of accepted) assert.equal((await rawRequest(site, "GET", "/api/me", { Host: host })).status, 401, host);
    for (const host of ["example.org", "game.example.org.evil", "[2001:db8::]"]) {
      assert.equal((await rawRequest(site, "GET", "/api/me", { Host: host })).status, 403, host);
    }
  });

  test("the start-up links name localhost and the network addresses of this computer", () => {
    const links = siteLinks(8080);
    assert.equal(links[0], "http://localhost:8080/");
    const ipv4 = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal);
    for (const entry of ipv4) assert.ok(links.includes(`http://${entry.address}:8080/`), entry.address);
    assert.ok(links.every((link) => !/\[fe[89ab]/i.test(link)), "no link-local IPv6");
  });
});

describe("forged and oversized requests", () => {
  test("a change without Origin or with a foreign Origin gets 403", async () => {
    const { site, admin } = await siteWithAdmin();
    for (const origin of [null, "http://evil.example", "null", `https://127.0.0.1:${site.server.port}`, `http://127.0.0.1:${site.server.port + 1}`]) {
      assertError(await call(site, "POST", "/api/auth/login", { origin, body: { login: "admin", password: ADMIN.password } }), "request.origin");
      const change = await call(site, "PUT", "/api/me/settings", { origin, cookie: admin, body: { lang: "en" } });
      assertError(change, "request.origin");
    }
    const me = await call(site, "GET", "/api/me", { cookie: admin });
    assert.deepEqual(me.body.settings, {});
  });

  test("a change that is not application/json gets 415", async () => {
    const { site, admin } = await siteWithAdmin();
    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp"]) {
      assertError(await call(site, "POST", "/api/auth/login", { contentType, body: { login: "admin", password: ADMIN.password } }), "request.contentType");
      assertError(await call(site, "PUT", "/api/me/settings", { contentType, cookie: admin, body: { lang: "en" } }), "request.contentType");
    }
    assert.equal((await call(site, "PUT", "/api/me/settings", { contentType: "Application/JSON; charset=utf-8", cookie: admin, body: { lang: "en" } })).status, 200);
  });

  test("a body that is not a JSON object gets 400", async () => {
    const { site } = await siteWithAdmin();
    const headers = { Origin: site.base, "Content-Type": "application/json" };
    for (const text of ["", "{", "[1]", "null", '"text"']) {
      const reply = await rawRequest(site, "POST", "/api/auth/login", { ...headers, "Content-Length": String(Buffer.byteLength(text)) }, [text]);
      assert.deepEqual({ status: reply.status, body: JSON.parse(reply.text) }, { status: 400, body: { error: "request.format" } }, text);
    }
  });

  test("sign-in and registration bodies over 4 KiB, others over 2 MiB, get 413", async () => {
    const { site, admin } = await siteWithAdmin();
    const headers = { Origin: site.base, "Content-Type": "application/json" };
    const tooLarge = { status: 413, text: '{"error":"request.tooLarge"}' };
    const short = (reply: RawReply) => ({ status: reply.status, text: reply.text });

    // A declared length over the limit is refused before anything is read.
    assert.deepEqual(short(await rawRequest(site, "POST", "/api/auth/login", { ...headers, "Content-Length": String(4 * 1024 + 1) })), tooLarge);
    assert.deepEqual(short(await rawRequest(site, "POST", "/api/auth/register", { ...headers, "Content-Length": String(4 * 1024 + 1) })), tooLarge);
    assert.deepEqual(
      short(await rawRequest(site, "PUT", "/api/me/settings", { ...headers, Cookie: admin, "Content-Length": String(2 * 1024 * 1024 + 1) })),
      tooLarge,
    );
    // A stream without a length is cut at the limit: the request is never finished, the answer still comes.
    assert.deepEqual(short(await rawRequest(site, "POST", "/api/auth/login", { ...headers, "Transfer-Encoding": "chunked" }, ["x".repeat(3000), "x".repeat(3000)])), tooLarge);

    const padded = JSON.stringify({ login: "admin", password: ADMIN.password, pad: "x".repeat(4 * 1024 - 60) });
    assert.ok(Buffer.byteLength(padded) <= 4 * 1024);
    const fits = await rawRequest(site, "POST", "/api/auth/login", { ...headers, "Content-Length": String(Buffer.byteLength(padded)) }, [padded]);
    assert.equal(fits.status, 200);
  });
});

describe("sessions", () => {
  test("a session lives through a restart of the server", async () => {
    const { site, admin } = await siteWithAdmin();
    await restart(site);
    const me = await call(site, "GET", "/api/me", { cookie: admin });
    assert.equal(me.status, 200);
    assert.equal(me.body.login, "admin");
  });

  test("signing out ends the session", async () => {
    const { site, admin } = await siteWithAdmin();
    const other = await login(site, "admin", ADMIN.password);
    const out = await call(site, "POST", "/api/auth/logout", { cookie: admin });
    assert.equal(out.status, 204);
    assert.match(out.setCookie ?? "", /^bm_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax$/);
    assertError(await call(site, "GET", "/api/me", { cookie: admin }), "auth.required");
    assert.equal((await call(site, "GET", "/api/me", { cookie: other.cookie })).status, 200, "other devices stay signed in");
  });

  test("a session ends after 30 days unused and is extended while used", async () => {
    const { site, admin } = await siteWithAdmin();
    site.clock.now += 20 * DAY_MS;
    const used = await call(site, "GET", "/api/me", { cookie: admin });
    assert.equal(used.status, 200);
    assert.match(used.setCookie ?? "", /Max-Age=2592000/, "the cookie is sent again with a new lifetime");
    const quiet = await call(site, "GET", "/api/me", { cookie: admin });
    assert.equal(quiet.setCookie, null, "not extended again the same day");

    site.clock.now += SESSION_LIFETIME_MS - 1;
    assert.equal((await call(site, "GET", "/api/me", { cookie: admin })).status, 200);
    site.clock.now += SESSION_LIFETIME_MS;
    assertError(await call(site, "GET", "/api/me", { cookie: admin }), "auth.required");
  });

  test("a made-up or damaged cookie is no session", async () => {
    const { site } = await siteWithAdmin();
    for (const cookie of ["bm_session=" + "A".repeat(43), "bm_session=short", "bm_session=", "other=1"]) {
      assertError(await call(site, "GET", "/api/me", { cookie }), "auth.required");
    }
  });
});

describe("administration", () => {
  test("a reset password must be changed before anything else", async () => {
    const { site, admin } = await siteWithAdmin();
    const user = await readyUser(site, admin, "anna");
    const reset = await call(site, "POST", "/api/admin/users", { cookie: admin, body: { action: "resetPassword", id: user.id } });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.user.mustChangePassword, true);
    assertError(await call(site, "GET", "/api/me", { cookie: user.cookie }), "auth.required");
    assertError(await login(site, "anna", "anna-password"), "auth.invalid");

    const temporary = await login(site, "anna", reset.body.password);
    assert.equal(temporary.status, 200);
    assert.equal(temporary.body.mustChangePassword, true);
    const cookie = temporary.cookie;
    assert.equal((await call(site, "GET", "/api/me", { cookie })).body.mustChangePassword, true);
    assertError(await call(site, "PUT", "/api/me/settings", { cookie, body: { lang: "en" } }), "auth.mustChangePassword");

    const change = (currentPassword: string, newPassword: string) => call(site, "POST", "/api/me/password", { cookie, body: { currentPassword, newPassword } });
    assertError(await change("wrong-password", "anna-new-password"), "password.wrong");
    assertError(await change(reset.body.password, reset.body.password), "password.same");
    assertError(await change(reset.body.password, "short"), "password.format");
    const changed = await change(reset.body.password, "anna-new-password");
    assert.equal(changed.status, 200);
    assert.equal(changed.body.mustChangePassword, false);
    assert.equal((await call(site, "PUT", "/api/me/settings", { cookie, body: { lang: "en" } })).status, 200);
    assert.equal((await login(site, "anna", "anna-new-password")).status, 200);
  });

  test("changing the password ends the other sessions of the user", async () => {
    const { site, admin } = await siteWithAdmin();
    const other = await login(site, "admin", ADMIN.password);
    const changed = await call(site, "POST", "/api/me/password", { cookie: admin, body: { currentPassword: ADMIN.password, newPassword: "admin-password-2" } });
    assert.equal(changed.status, 200);
    assert.equal((await call(site, "GET", "/api/me", { cookie: admin })).status, 200);
    assertError(await call(site, "GET", "/api/me", { cookie: other.cookie }), "auth.required");
  });

  test("a disabled user cannot sign in and is signed out everywhere; enabling brings the account back", async () => {
    const { site, admin } = await siteWithAdmin();
    const user = await readyUser(site, admin, "boris");
    const disabled = await call(site, "POST", "/api/admin/users", { cookie: admin, body: { action: "setDisabled", id: user.id, disabled: true } });
    assert.equal(disabled.body.user.disabled, true);
    assertError(await call(site, "GET", "/api/me", { cookie: user.cookie }), "auth.required");
    assertError(await login(site, "boris", "boris-password"), "auth.disabled");
    assertError(await login(site, "boris", "wrong-password"), "auth.invalid");

    await call(site, "POST", "/api/admin/users", { cookie: admin, body: { action: "setDisabled", id: user.id, disabled: false } });
    assert.equal((await login(site, "boris", "boris-password")).status, 200);
  });

  test("an administrator creates users with a temporary password and lists them", async () => {
    const { site, admin } = await siteWithAdmin();
    const created = await createUser(site, admin, "second_admin", "admin");
    assert.match(created.password, /^[a-z2-9]{12}$/);
    assertError(await call(site, "POST", "/api/admin/users", { cookie: admin, body: { action: "create", login: "second_admin", displayName: "X" } }), "login.taken");
    assertError(await call(site, "POST", "/api/admin/users", { cookie: admin, body: { action: "create", login: "x", displayName: "X", role: "root" } }), "request.format");
    assertError(await call(site, "POST", "/api/admin/users", { cookie: admin, body: { action: "explode" } }), "request.format");

    const list = await call(site, "GET", "/api/admin/users", { cookie: admin });
    assert.deepEqual(
      list.body.users.map((user: { login: string; role: string; mustChangePassword: boolean }) => [user.login, user.role, user.mustChangePassword]),
      [
        ["admin", "admin", false],
        ["second_admin", "admin", true],
      ],
    );
    assert.ok(list.body.users.every((user: object) => !("passHash" in user) && !("passSalt" in user)));
  });

  test("an administrator cannot reset or disable their own account; unknown users are 404", async () => {
    const { site, admin } = await siteWithAdmin();
    const me = await call(site, "GET", "/api/me", { cookie: admin });
    for (const body of [{ action: "resetPassword", id: me.body.id }, { action: "setDisabled", id: me.body.id, disabled: true }]) {
      assertError(await call(site, "POST", "/api/admin/users", { cookie: admin, body }), "admin.self");
    }
    for (const body of [{ action: "resetPassword", id: 999 }, { action: "setDisabled", id: 999, disabled: true }]) {
      assertError(await call(site, "POST", "/api/admin/users", { cookie: admin, body }), "user.notFound");
    }
  });
});

describe("rights on every request", () => {
  const adminRequests: [string, string, unknown][] = [
    ["GET", "/api/admin/users", undefined],
    ["POST", "/api/admin/users", { action: "create", login: "sneaky", displayName: "S" }],
    ["POST", "/api/admin/users", { action: "resetPassword", id: 1 }],
    ["POST", "/api/admin/users", { action: "setDisabled", id: 1, disabled: true }],
    ["POST", "/api/admin/users", { action: "setRole", id: 1, role: "user" }],
    ["POST", "/api/admin/invites", { maxUses: 1, days: 1 }],
    ["GET", "/api/admin/settings", undefined],
    ["PUT", "/api/admin/settings", { openRegistration: true }],
  ];

  test("a user who is not an administrator gets 403 on every administration request", async () => {
    const { site, admin } = await siteWithAdmin();
    const user = await readyUser(site, admin, "carol");
    for (const [method, url, body] of adminRequests) {
      assertError(await call(site, method, url, { cookie: user.cookie, body }), "auth.forbidden");
    }
    const list = await call(site, "GET", "/api/admin/users", { cookie: admin });
    assert.deepEqual(list.body.users.map((entry: { login: string }) => entry.login), ["admin", "carol"]);
    assert.equal(list.body.users[0].disabled, false);
    assert.equal((await call(site, "GET", "/api/admin/settings", { cookie: admin })).body.openRegistration, false);
  });

  test("without a session every request but sign-in and registration gets 401", async () => {
    const { site } = await siteWithAdmin();
    const signedInRequests: [string, string, unknown][] = [
      ...adminRequests,
      ["POST", "/api/me/password", { currentPassword: ADMIN.password, newPassword: "whatever-new" }],
      ["PUT", "/api/me/settings", { lang: "en" }],
    ];
    for (const [method, url, body] of signedInRequests) {
      assertError(await call(site, method, url, { body }), "auth.required");
    }
  });

  test("a user with a reset password gets 403 on administration too", async () => {
    const { site, admin } = await siteWithAdmin();
    const second = await createUser(site, admin, "second_admin", "admin");
    const { cookie } = await login(site, "second_admin", second.password);
    for (const [method, url, body] of adminRequests) {
      assertError(await call(site, method, url, { cookie, body }), "auth.mustChangePassword");
    }
  });

  test("unknown API paths and methods are 404", async () => {
    const { site, admin } = await siteWithAdmin();
    assertError(await call(site, "GET", "/api/nothing", { cookie: admin }), "request.notFound");
    assertError(await call(site, "DELETE", "/api/me", { cookie: admin }), "request.notFound");
    assertError(await call(site, "GET", "/api/auth/login"), "request.notFound");
  });
});

describe("language and theme in the account", () => {
  test("saved on one device, they come in api/me on another", async () => {
    const { site, admin } = await siteWithAdmin();
    const saved = await call(site, "PUT", "/api/me/settings", { cookie: admin, body: { lang: "en", theme: "dungeon" } });
    assert.deepEqual(saved.body, { settings: { lang: "en", theme: "dungeon" } });
    await call(site, "PUT", "/api/me/settings", { cookie: admin, body: { theme: "contrast" } });

    const otherDevice = await login(site, "admin", ADMIN.password);
    assert.deepEqual(otherDevice.body.settings, { lang: "en", theme: "contrast" });
    assert.deepEqual((await call(site, "GET", "/api/me", { cookie: otherDevice.cookie })).body.settings, { lang: "en", theme: "contrast" });
  });

  test("unknown languages, themes and keys are refused", async () => {
    const { site, admin } = await siteWithAdmin();
    for (const body of [{ lang: "de" }, { theme: "neon" }, { color: "red" }, { lang: 1 }]) {
      assertError(await call(site, "PUT", "/api/me/settings", { cookie: admin, body }), "request.format");
    }
    assert.deepEqual((await call(site, "GET", "/api/me", { cookie: admin })).body.settings, {});
  });
});

describe("own colours of the void and the grid, and the expanded tool column (R45)", () => {
  test("kept in the account: they come back after signing out and in on another device", async () => {
    const { site, admin } = await siteWithAdmin();
    const saved = await call(site, "PUT", "/api/me/settings", {
      cookie: admin,
      body: { voidColor: "#1A2b3c", gridColor: "#ffcc00", toolsExpanded: true },
    });
    assert.deepEqual(saved.body, { settings: { voidColor: "#1a2b3c", gridColor: "#ffcc00", toolsExpanded: true } });
    assert.equal((await call(site, "POST", "/api/auth/logout", { cookie: admin })).status, 204);

    const again = await login(site, "admin", ADMIN.password);
    assert.deepEqual(again.body.settings, { voidColor: "#1a2b3c", gridColor: "#ffcc00", toolsExpanded: true });
  });

  test("null takes a colour back to the theme's; the other settings stay", async () => {
    const { site, admin } = await siteWithAdmin();
    await call(site, "PUT", "/api/me/settings", { cookie: admin, body: { theme: "dark", voidColor: "#101010", gridColor: "#202020" } });
    const reset = await call(site, "PUT", "/api/me/settings", { cookie: admin, body: { voidColor: null } });
    assert.deepEqual(reset.body, { settings: { theme: "dark", gridColor: "#202020" } });
    assert.deepEqual((await call(site, "GET", "/api/me", { cookie: admin })).body.settings, { theme: "dark", gridColor: "#202020" });
  });

  test("anything but #rrggbb, null or a boolean for the expanded column is refused and nothing is saved", async () => {
    const { site, admin } = await siteWithAdmin();
    const refused = [
      { voidColor: "red" },
      { voidColor: "#fff" },
      { gridColor: "#12345g" },
      { gridColor: `#${"a".repeat(9999)}` },
      { voidColor: 0x123456 },
      { gridColor: "#1234567" },
      { gridColor: " #123456" },
      { voidColor: "rgba(0, 0, 0, 0.5)" },
      { voidColor: ["#123456"] },
      { toolsExpanded: "true" },
      { toolsExpanded: 1 },
      { toolsExpanded: null },
      { theme: "dark", voidColor: "blue" },
    ];
    for (const body of refused) {
      assertError(await call(site, "PUT", "/api/me/settings", { cookie: admin, body }), "request.format");
    }
    assert.deepEqual((await call(site, "GET", "/api/me", { cookie: admin })).body.settings, {});
  });

  test("a stored value that is no longer valid is not shown", async () => {
    const { site, admin } = await siteWithAdmin();
    await site.server.close();
    const db = new DatabaseSync(path.join(site.dir, "battlemap.db"));
    db.prepare("UPDATE users SET settings_json = ? WHERE login = 'admin'").run('{"voidColor":"red","gridColor":"#abcdef","toolsExpanded":"yes"}');
    db.close();
    const again = await start(site.dir, site.clock);
    site.server = again.server;
    site.base = again.base;
    assert.deepEqual((await call(site, "GET", "/api/me", { cookie: admin })).body.settings, { gridColor: "#abcdef" });
  });
});

describe("error codes", () => {
  test("every server error code has a text in both dictionaries, and no dictionary has stale ones", () => {
    const expected = [...Object.keys(ERRORS), ...CLIENT_ERRORS].map((code) => `error.${code}`).sort();
    for (const [name, dictionary] of Object.entries({ ru, en })) {
      const actual = Object.keys(dictionary).filter((key) => key.startsWith("error.")).sort();
      assert.deepEqual(actual, expected, name);
    }
  });

  test("every status matches plan 6.4", () => {
    // 410: an expired game invite (plan 8.5).
    const allowed = new Set([400, 401, 403, 404, 410, 413, 415, 429, 500]);
    for (const [code, status] of Object.entries(ERRORS)) assert.ok(allowed.has(status), `${code}: ${status}`);
  });
});

describe("what is kept on disk", () => {
  test("the data folder holds no passwords, session tokens or registration codes in plain text", async () => {
    const { site, admin } = await siteWithAdmin();
    const user = await readyUser(site, admin, "dana", "dana-secret-password");
    const signedIn = await login(site, "dana", "dana-secret-password");
    const invite = await call(site, "POST", "/api/admin/invites", { cookie: admin, body: { maxUses: 5, days: 3 } });
    // Closed so that everything is on disk; a new server is started below for the cleanup to close.
    await site.server.close();

    const secrets = [ADMIN.password, "dana-secret-password", admin, user.cookie, signedIn.cookie ?? "", invite.body.code].map((secret) => secret.replace(/^bm_session=/, ""));
    const files = readdirSync(site.dir);
    assert.ok(files.includes("battlemap.db"));
    for (const file of files) {
      const content = readFileSync(path.join(site.dir, file));
      for (const secret of secrets) {
        assert.equal(content.includes(Buffer.from(secret, "utf8")), false, `${file} holds ${secret}`);
        assert.equal(content.includes(Buffer.from(secret, "utf16le")), false, `${file} holds ${secret} as UTF-16`);
      }
    }
    // The database really is there: the login is stored as is.
    assert.ok(readFileSync(path.join(site.dir, "battlemap.db")).includes(Buffer.from("dana")));
    site.server = (await start(site.dir, site.clock)).server;
  });
});

describe("client files", () => {
  test("the page and its files are served with no-cache and the security headers", async () => {
    const site = await newSite();
    for (const [url, type] of [
      ["/", "text/html; charset=utf-8"],
      ["/index.html", "text/html; charset=utf-8"],
      ["/style.css", "text/css; charset=utf-8"],
      ["/themes.css", "text/css; charset=utf-8"],
      ["/fonts/fonts.css", "text/css; charset=utf-8"],
      ["/fonts/golos-text-cyrillic.woff2", "font/woff2"],
      ["/fonts/golos-text-latin.woff2", "font/woff2"],
      ["/fonts/jetbrains-mono-500-cyrillic.woff2", "font/woff2"],
      ["/fonts/jetbrains-mono-500-latin.woff2", "font/woff2"],
      ["/fonts/OFL-golos-text.txt", "text/plain; charset=utf-8"],
      ["/fonts/OFL-jetbrains-mono.txt", "text/plain; charset=utf-8"],
    ]) {
      const response = await fetch(site.base + url);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get("content-type"), type);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      const again = await fetch(site.base + url, { headers: { "If-None-Match": response.headers.get("etag") ?? "" } });
      assert.equal(again.status, 304, `${url} again`);
    }
  });

  test("every response carries the security headers: 200, 304, 401, 403, 404, 413, 415", async () => {
    const site = await newSite();
    const json = { Origin: site.base, "Content-Type": "application/json" };
    const page = await rawRequest(site, "GET", "/");
    const replies: [number, RawReply][] = [
      [200, page],
      [304, await rawRequest(site, "GET", "/", { "If-None-Match": String(page.headers.etag) })],
      [401, await rawRequest(site, "GET", "/api/me")],
      [403, await rawRequest(site, "POST", "/api/auth/login", { "Content-Type": "application/json", "Content-Length": "2" }, ["{}"])],
      [403, await rawRequest(site, "GET", "/", { Host: "evil.example" })],
      [404, await rawRequest(site, "GET", "/nothing.txt")],
      [413, await rawRequest(site, "POST", "/api/auth/login", { ...json, "Content-Length": String(5000) })],
      [415, await rawRequest(site, "POST", "/api/auth/login", { Origin: site.base, "Content-Type": "text/plain", "Content-Length": "2" }, ["{}"])],
    ];
    for (const [status, reply] of replies) {
      assert.equal(reply.status, status);
      assert.equal(reply.headers["content-security-policy"], "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", `${status}`);
      assert.equal(reply.headers["x-content-type-options"], "nosniff", `${status}`);
      assert.equal(reply.headers["referrer-policy"], "no-referrer", `${status}`);
    }
  });

  test("a body the client breaks off is not logged as a server error", async () => {
    const site = await newSite();
    await new Promise<void>((resolve) => {
      const request = http.request({
        host: "127.0.0.1",
        port: site.server.port,
        method: "POST",
        path: "/api/auth/login",
        headers: { Origin: site.base, "Content-Type": "application/json", "Content-Length": "100" },
      });
      request.on("error", () => resolve());
      request.on("close", () => resolve());
      request.write('{"login":', () => setTimeout(() => request.destroy(), 50));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(site.log.filter((line) => /error/i.test(line)), []);
  });

  test("nothing outside client/ and nothing but the page files is served", async () => {
    const site = await newSite();
    const targets = [
      "/../package.json",
      "/..%2fpackage.json",
      "/%2e%2e/package.json",
      "/%2e%2e%2fpackage.json",
      "/..%5cpackage.json",
      "/%2e%2e%5cpackage.json",
      "/dist/../../package.json",
      "/dist/..%2f..%2fpackage.json",
      "/dist/%2e%2e%5c%2e%2e%5cpackage.json",
      "/dist/..",
      "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/Windows/win.ini",
      "/C:/Windows/win.ini",
      "/C:%5cWindows%5cwin.ini",
      "//etc/passwd",
      "/tsconfig.json",
      "/src/main.ts",
      "/index.html%00.css",
      "/index.html::$DATA",
      "/%E0%A4%A",
      "/dist",
      "/dist/",
      "/fonts/../server/app.ts",
      "/fonts/..%2fserver%2fapp.ts",
      "/fonts/%2e%2e/server/app.ts",
      "/fonts/%2e%2e%5cserver%5capp.ts",
      "/fonts/x.ttf",
      "/fonts/sub/a.woff2",
      "/fonts/sub%2fa.woff2",
      "/fonts/.woff2",
      "/fonts/GOLOS-TEXT-LATIN.woff2",
      "/fonts/golos-text-latin.woff2.map",
      "/fonts/notes.txt",
      "/fonts/OFL-golos-text.txt%00.woff2",
      "/fonts",
      "/fonts/",
    ];
    for (const target of targets) {
      const reply = await rawRequest(site, "GET", target);
      assert.deepEqual({ status: reply.status, text: reply.text }, { status: 404, text: '{"error":"request.notFound"}' }, target);
    }
    const post = await call(site, "POST", "/index.html");
    assertError(post, "request.notFound");
  });
});
