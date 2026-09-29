// Accounts, passwords, sessions and the limit on password guessing (plan 5.10, 6.2, R11, R18).
// Knows nothing about HTTP: the routes in app.ts pass values in and turn ApiError into a response.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { isLang } from "../client/src/i18n/index.ts";
import type { LANGS } from "../client/src/i18n/index.ts";
import { isThemeChoice } from "../client/src/theme.ts";
import type { THEME_CHOICES } from "../client/src/theme.ts";
import type { Database, Role, User } from "./db.ts";
import { ApiError } from "./errors.ts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const SESSION_COOKIE = "bm_session";
export const SESSION_LIFETIME_MS = 30 * DAY_MS;
/** The expiry moves forward at most once a day, so an ordinary request does not write to the database. */
const SESSION_EXTEND_STEP_MS = DAY_MS;

export const LOGIN_WINDOW_MS = 15 * MINUTE_MS;
export const LOGIN_MAX_FAILURES = 10;

export const INVITE_LIFETIME_MS = 7 * DAY_MS;

const SALT_BYTES = 16;
const HASH_BYTES = 64;
const TOKEN_BYTES = 32;
/** base64url of TOKEN_BYTES bytes, without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Letters and digits that are hard to confuse when read aloud or copied by hand: 32 of them, 5 bits each. */
const READABLE = "abcdefghijkmnpqrstuvwxyz23456789";
const TEMPORARY_PASSWORD_LENGTH = 12;
const INVITE_CODE_LENGTH = 16;

// ---- input checks (plan 6.2) ----

const LOGIN_PATTERN = /^[a-z0-9_]{3,24}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;

const length = (text: string): number => [...text].length;

export function checkLogin(value: string): string {
  if (!LOGIN_PATTERN.test(value)) throw new ApiError("login.format");
  return value;
}

/** Up to 40 characters after trimming, not empty, no control characters. */
export function checkDisplayName(value: string): string {
  const name = value.trim();
  if (name === "" || length(name) > 40 || CONTROL_CHARACTER.test(name)) throw new ApiError("name.format");
  return name;
}

export function checkPassword(value: string): string {
  const size = length(value);
  if (size < 8 || size > 200) throw new ApiError("password.format");
  return value;
}

// ---- secrets ----

export function hashPassword(password: string, salt: Uint8Array): Promise<Buffer> {
  // Asynchronous: scrypt runs in the thread pool and does not stop other requests.
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, HASH_BYTES, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function passwordMatches(password: string, salt: Uint8Array, expected: Uint8Array): Promise<boolean> {
  const actual = await hashPassword(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

/** Compares two secrets in time that does not depend on where they differ. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function readableText(size: number): string {
  // 256 is a multiple of 32, so taking the low 5 bits of each byte is uniform.
  return [...randomBytes(size)].map((byte) => READABLE[byte & 31]).join("");
}

// ---- limit on failed attempts ----

/** Counts failures per key in a sliding window. Attempts are booked before the slow password check. */
export class AttemptLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #failures = new Map<string, number[]>();

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /**
   * Books an attempt as a failure; false when the key already has `max` failures in the window.
   * Booking first means parallel requests cannot all pass the check before any of them fails.
   */
  take(key: string, now: number): boolean {
    if (this.#failures.size > 10_000) this.#sweep(now);
    const recent = (this.#failures.get(key) ?? []).filter((time) => time > now - this.#windowMs);
    if (recent.length >= this.#max) {
      this.#failures.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#failures.set(key, recent);
    return true;
  }

  /** Takes back an attempt booked at `time` that turned out not to be a failure. */
  giveBack(key: string, time: number): void {
    const list = this.#failures.get(key);
    const index = list ? list.indexOf(time) : -1;
    if (!list || index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) this.#failures.delete(key);
  }

  #sweep(now: number): void {
    for (const [key, list] of this.#failures) {
      if (list.every((time) => time <= now - this.#windowMs)) this.#failures.delete(key);
    }
  }
}

// ---- account settings (plan 5.15) ----

export interface AccountSettings {
  lang?: (typeof LANGS)[number];
  theme?: (typeof THEME_CHOICES)[number];
}

function parseSettings(json: string): AccountSettings {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const settings: AccountSettings = {};
  if ("lang" in value && isLang(value.lang)) settings.lang = value.lang;
  if ("theme" in value && isThemeChoice(value.theme)) settings.theme = value.theme;
  return settings;
}

/** Checks a settings change: only known keys with known values. */
export function checkSettings(input: Record<string, unknown>): AccountSettings {
  const settings: AccountSettings = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "lang" && isLang(value)) settings.lang = value;
    else if (key === "theme" && isThemeChoice(value)) settings.theme = value;
    else throw new ApiError("request.format");
  }
  return settings;
}

// ---- what the API shows about a user ----

export function userView(user: User) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    disabled: user.disabled,
    createdAt: user.createdAt,
  };
}

export function meView(user: User) {
  return { ...userView(user), settings: parseSettings(user.settingsJson) };
}

// ---- accounts ----

export interface SignedIn {
  user: User;
  token: string;
}

/** The session behind a request. `extended` means its expiry moved and the cookie must be sent again. */
export interface Authenticated {
  user: User;
  token: string;
  tokenHash: Buffer;
  extended: boolean;
}

export interface Registration {
  login: string;
  displayName: string;
  password: string;
  /** Registration code from an administrator. */
  code?: string;
  /** The first-administrator token from the console link. */
  setup?: string;
}

export class Accounts {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #limiter = new AttemptLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);
  /** A random password nobody knows: checked against when the login does not exist, so both cases take as long. */
  readonly #decoy = { salt: randomBytes(SALT_BYTES), hash: randomBytes(HASH_BYTES) };
  #setupToken: string | null = null;

  constructor(db: Database, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * With no users in the database, makes the one-time token for creating the first administrator.
   * It lives in memory only, until it is used or the server restarts. Null when users exist.
   */
  startSetup(): string | null {
    this.#setupToken = this.#db.countUsers() === 0 ? randomBytes(TOKEN_BYTES).toString("base64url") : null;
    return this.#setupToken;
  }

  #setupMatches(token: string): boolean {
    return this.#setupToken !== null && sameSecret(token, this.#setupToken) && this.#db.countUsers() === 0;
  }

  /** Registration without a code: open registration is on, and the first administrator exists (until then only the setup link registers). */
  registrationOpen(openRegistration: boolean): boolean {
    return openRegistration && this.#db.countUsers() > 0;
  }

  async register(input: Registration, openRegistration: boolean): Promise<SignedIn> {
    const login = checkLogin(input.login);
    const displayName = checkDisplayName(input.displayName);
    const password = checkPassword(input.password);
    const now = this.#now();

    const { setup, code } = input;
    const asAdmin = setup !== undefined;
    const needsInvite = !asAdmin && !this.registrationOpen(openRegistration);
    const allowed = (): boolean =>
      setup !== undefined
        ? this.#setupMatches(setup)
        : !needsInvite || (code !== undefined && this.#db.hasInvite(code, "register", now));
    const refusal = asAdmin ? "auth.setupInvalid" : "auth.inviteInvalid";

    // The invite is checked before the login, so without one nobody learns which logins exist.
    if (!allowed()) throw new ApiError(refusal);
    if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");

    const salt = randomBytes(SALT_BYTES);
    const hash = await hashPassword(password, salt);

    // Checked again: other requests ran while the password was hashed.
    const user = this.#db.transaction(() => {
      if (!allowed()) throw new ApiError(refusal);
      if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");
      if (needsInvite && code !== undefined) this.#db.takeInvite(code, "register", now);
      return this.#db.insertUser({
        login,
        displayName,
        passHash: hash,
        passSalt: salt,
        role: asAdmin ? "admin" : "user",
        mustChangePassword: false,
        createdAt: now,
      });
    });
    if (asAdmin) this.#setupToken = null;
    return { user, token: this.#newSession(user, now) };
  }

  /** The same `auth.invalid` for an unknown login and a wrong password. */
  async login(login: string, password: string, address: string): Promise<SignedIn> {
    const user = await this.#checkPassword(login, password, address, "auth.invalid");
    if (user.disabled) throw new ApiError("auth.disabled");
    return { user, token: this.#newSession(user, this.#now()) };
  }

  /**
   * Checks a password under the limit of LOGIN_MAX_FAILURES per LOGIN_WINDOW_MS, separately for the address
   * and for the login. A failure throws `failure`; over the limit, `auth.tooManyAttempts`, even for the right password.
   */
  async #checkPassword(login: string, password: string, address: string, failure: "auth.invalid" | "password.wrong"): Promise<User> {
    const now = this.#now();
    const keys = [`address:${address}`];
    // A malformed login cannot exist, and keeping it would let anyone fill memory with junk keys.
    if (LOGIN_PATTERN.test(login)) keys.push(`login:${login}`);
    const booked: string[] = [];
    for (const key of keys) {
      if (!this.#limiter.take(key, now)) {
        for (const done of booked) this.#limiter.giveBack(done, now);
        throw new ApiError("auth.tooManyAttempts");
      }
      booked.push(key);
    }

    const user = booked.length > 1 ? this.#db.findUserByLogin(login) : undefined;
    const matches = await passwordMatches(password, user?.passSalt ?? this.#decoy.salt, user?.passHash ?? this.#decoy.hash);
    if (!user || !matches) throw new ApiError(failure);
    for (const key of booked) this.#limiter.giveBack(key, now);
    return user;
  }

  #newSession(user: User, now: number): string {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    this.#db.insertSession(sha256(token), user.id, now + SESSION_LIFETIME_MS);
    return token;
  }

  /** The signed-in user for a session cookie, or null. Extends the session while it is used. */
  authenticate(token: string | undefined): Authenticated | null {
    if (token === undefined || !TOKEN_PATTERN.test(token)) return null;
    const tokenHash = sha256(token);
    const session = this.#db.findSession(tokenHash);
    if (!session) return null;
    const now = this.#now();
    const user = this.#db.findUserById(session.userId);
    if (session.expiresAt <= now || !user || user.disabled) {
      this.#db.deleteSession(tokenHash);
      return null;
    }
    const extended = session.expiresAt < now + SESSION_LIFETIME_MS - SESSION_EXTEND_STEP_MS;
    if (extended) this.#db.setSessionExpiry(tokenHash, now + SESSION_LIFETIME_MS);
    return { user, token, tokenHash, extended };
  }

  logout(auth: Authenticated): void {
    this.#db.deleteSession(auth.tokenHash);
  }

  /** Needs the current password; ends every other session of the user. */
  async changePassword(auth: Authenticated, current: string, next: string, address: string): Promise<User> {
    checkPassword(next);
    if (current === next) throw new ApiError("password.same");
    const user = await this.#checkPassword(auth.user.login, current, address, "password.wrong");
    const salt = randomBytes(SALT_BYTES);
    const hash = await hashPassword(next, salt);
    this.#db.transaction(() => {
      this.#db.setPassword(user.id, hash, salt, false);
      this.#db.deleteUserSessions(user.id, auth.tokenHash);
    });
    return this.#existing(user.id);
  }

  saveSettings(user: User, change: AccountSettings): AccountSettings {
    const settings = { ...parseSettings(user.settingsJson), ...change };
    this.#db.setSettings(user.id, JSON.stringify(settings));
    return settings;
  }

  // ---- administration; the routes let only administrators in ----

  listUsers(): User[] {
    return this.#db.listUsers();
  }

  /** A new user with a temporary password that must be changed at the first sign-in. */
  async createUser(loginInput: string, displayNameInput: string, role: Role): Promise<{ user: User; password: string }> {
    const login = checkLogin(loginInput);
    const displayName = checkDisplayName(displayNameInput);
    if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");
    const password = readableText(TEMPORARY_PASSWORD_LENGTH);
    const salt = randomBytes(SALT_BYTES);
    const hash = await hashPassword(password, salt);
    const user = this.#db.transaction(() => {
      if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");
      return this.#db.insertUser({
        login,
        displayName,
        passHash: hash,
        passSalt: salt,
        role,
        mustChangePassword: true,
        createdAt: this.#now(),
      });
    });
    return { user, password };
  }

  /** Gives the user a temporary password that must be changed, and ends all of their sessions. */
  async resetPassword(admin: User, id: number): Promise<{ user: User; password: string }> {
    this.#other(admin, id);
    const password = readableText(TEMPORARY_PASSWORD_LENGTH);
    const salt = randomBytes(SALT_BYTES);
    const hash = await hashPassword(password, salt);
    this.#db.transaction(() => {
      this.#existing(id);
      this.#db.setPassword(id, hash, salt, true);
      this.#db.deleteUserSessions(id);
    });
    return { user: this.#existing(id), password };
  }

  /** Disabling also ends all sessions of the user. */
  setDisabled(admin: User, id: number, disabled: boolean): User {
    this.#other(admin, id);
    this.#db.transaction(() => {
      this.#db.setDisabled(id, disabled);
      if (disabled) this.#db.deleteUserSessions(id);
    });
    return this.#existing(id);
  }

  createInvite(admin: User): { code: string; expiresAt: number } {
    const code = readableText(INVITE_CODE_LENGTH);
    const expiresAt = this.#now() + INVITE_LIFETIME_MS;
    this.#db.insertInvite(code, "register", null, admin.id, expiresAt);
    return { code, expiresAt };
  }

  #existing(id: number): User {
    const user = this.#db.findUserById(id);
    if (!user) throw new ApiError("user.notFound");
    return user;
  }

  /** An administrator does not lock themselves out: their own account is not reset or disabled here. */
  #other(admin: User, id: number): void {
    if (id === admin.id) throw new ApiError("admin.self");
    this.#existing(id);
  }
}
