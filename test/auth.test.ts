// Accounts, sessions and the server's security rules (plan 5.10, 6.2, 6.4, 8.4), through real HTTP
// on a free port of 127.0.0.1 with the data in a temporary folder.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { CLIENT_ERRORS } from "../client/src/app/api.ts";
import { en } from "../client/src/i18n/en.ts";
import { ru } from "../client/src/i18n/ru.ts";
import { startServer } from "../server/app.ts";
import type { RunningServer } from "../server/app.ts";
import { Accounts, INVITE_LIFETIME_MS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, SESSION_LIFETIME_MS } from "../server/auth.ts";
import { Database } from "../server/db.ts";
import { ApiError, ERRORS } from "../server/errors.ts";
import type { ErrorCode } from "../server/errors.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
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

async function newSite(): Promise<Site> {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-auth-"));
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

/** A raw request: the path is sent exactly as given, the body is written as `chunks` and not ended. */
function rawRequest(site: Site, method: string, target: string, headers: Record<string, string> = {}, chunks: string[] = []): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: site.server.port, method, path: target, headers });
    request.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, text });
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
    assert.deepEqual(settings, { port: 8080, openRegistration: false });
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
    const invite = await call(site, "POST", "/api/admin/invites", { cookie: admin });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.expiresAt, site.clock.now + INVITE_LIFETIME_MS);

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
    const invite = await call(site, "POST", "/api/admin/invites", { cookie: admin });
    site.clock.now += INVITE_LIFETIME_MS;
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

describe("password guessing", () => {
  test("the 11th failed attempt in 15 minutes from one address gets 429, even with the right password", async () => {
    const { site } = await siteWithAdmin();
    for (let attempt = 1; attempt <= LOGIN_MAX_FAILURES; attempt++) {
      // Different logins: the address limit alone must stop it.
      assertError(await login(site, `guess_${attempt}`, "wrong-password"), "auth.invalid");
    }
    assertError(await login(site, "admin", ADMIN.password), "auth.tooManyAttempts");

    site.clock.now += LOGIN_WINDOW_MS;
    assert.equal((await login(site, "admin", ADMIN.password)).status, 200);
  });

  test("the 11th failed attempt in 15 minutes on one login gets 429, from any address", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-auth-"));
    const db = new Database(path.join(dir, "battlemap.db"));
    cleanups.push(async () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const clock = { now: Date.UTC(2026, 0, 1) };
    const accounts = new Accounts(db, () => clock.now);
    const setup = accounts.startSetup() ?? "";
    await accounts.register({ ...ADMIN, setup }, false);

    const failure = (promise: Promise<unknown>) => promise.then(() => "ok", (error: ApiError) => error.code);
    for (let attempt = 1; attempt <= LOGIN_MAX_FAILURES; attempt++) {
      assert.equal(await failure(accounts.login("admin", "wrong-password", `10.0.0.${attempt}`)), "auth.invalid");
    }
    assert.equal(await failure(accounts.login("admin", ADMIN.password, "10.0.1.1")), "auth.tooManyAttempts");
    // Only this login is blocked, not the addresses.
    assert.equal(await failure(accounts.login("other", "wrong-password", "10.0.0.1")), "auth.invalid");

    clock.now += LOGIN_WINDOW_MS - 1;
    assert.equal(await failure(accounts.login("admin", ADMIN.password, "10.0.1.1")), "auth.tooManyAttempts");
    clock.now += 1;
    assert.equal(await failure(accounts.login("admin", ADMIN.password, "10.0.1.1")), "ok");
  });

  test("parallel attempts cannot slip past the limit", async () => {
    const { site } = await siteWithAdmin();
    const replies = await Promise.all(Array.from({ length: 15 }, () => login(site, "admin", "wrong-password")));
    const statuses = replies.map((reply) => reply.status).sort();
    assert.deepEqual(statuses, [...Array(LOGIN_MAX_FAILURES).fill(401), ...Array(5).fill(429)]);
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

    // A declared length over the limit is refused before anything is read.
    assert.deepEqual(await rawRequest(site, "POST", "/api/auth/login", { ...headers, "Content-Length": String(4 * 1024 + 1) }), tooLarge);
    assert.deepEqual(await rawRequest(site, "POST", "/api/auth/register", { ...headers, "Content-Length": String(4 * 1024 + 1) }), tooLarge);
    assert.deepEqual(
      await rawRequest(site, "PUT", "/api/me/settings", { ...headers, Cookie: admin, "Content-Length": String(2 * 1024 * 1024 + 1) }),
      tooLarge,
    );
    // A stream without a length is cut at the limit: the request is never finished, the answer still comes.
    assert.deepEqual(await rawRequest(site, "POST", "/api/auth/login", { ...headers, "Transfer-Encoding": "chunked" }, ["x".repeat(3000), "x".repeat(3000)]), tooLarge);

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
    ["POST", "/api/admin/invites", {}],
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

describe("error codes", () => {
  test("every server error code has a text in both dictionaries, and no dictionary has stale ones", () => {
    const expected = [...Object.keys(ERRORS), ...CLIENT_ERRORS].map((code) => `error.${code}`).sort();
    for (const [name, dictionary] of Object.entries({ ru, en })) {
      const actual = Object.keys(dictionary).filter((key) => key.startsWith("error.")).sort();
      assert.deepEqual(actual, expected, name);
    }
  });

  test("every status matches plan 6.4", () => {
    const allowed = new Set([400, 401, 403, 404, 413, 415, 429, 500]);
    for (const [code, status] of Object.entries(ERRORS)) assert.ok(allowed.has(status), `${code}: ${status}`);
  });
});

describe("what is kept on disk", () => {
  test("the data folder holds neither passwords nor session tokens in plain text", async () => {
    const { site, admin } = await siteWithAdmin();
    const user = await readyUser(site, admin, "dana", "dana-secret-password");
    const signedIn = await login(site, "dana", "dana-secret-password");
    // Closed so that everything is on disk; a new server is started below for the cleanup to close.
    await site.server.close();

    const secrets = [ADMIN.password, "dana-secret-password", admin, user.cookie, signedIn.cookie ?? ""].map((secret) => secret.replace(/^bm_session=/, ""));
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
    ]) {
      const response = await fetch(site.base + url);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get("content-type"), type);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      const again = await fetch(site.base + url, { headers: { "If-None-Match": response.headers.get("etag") ?? "" } });
      assert.equal(again.status, 304, `${url} again`);
    }
  });

  test("every response carries the security headers", async () => {
    const site = await newSite();
    for (const url of ["/", "/api/me", "/nothing.txt"]) {
      const response = await fetch(site.base + url);
      assert.equal(response.headers.get("content-security-policy"), "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", url);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", url);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer", url);
    }
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
    ];
    for (const target of targets) {
      const reply = await rawRequest(site, "GET", target);
      assert.deepEqual(reply, { status: 404, text: '{"error":"request.notFound"}' }, target);
    }
    const post = await call(site, "POST", "/index.html");
    assertError(post, "request.notFound");
  });
});
