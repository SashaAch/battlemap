// Accounts, sessions, registration and the limits on password guessing (plan 5.10, 6.2, R11, R18, R38, R39).
// Knows nothing about HTTP: the routes in app.ts pass values in and turn ApiError into a response.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { isLang } from "../client/src/i18n/index.ts";
import type { LANGS } from "../client/src/i18n/index.ts";
import { isThemeChoice } from "../client/src/theme.ts";
import type { THEME_CHOICES } from "../client/src/theme.ts";
import type { Database, Role, User } from "./db.ts";
import { ApiError } from "./errors.ts";
import { addressKey, AttemptLimiter } from "./limits.ts";
import { decoyPassword, isCurrent, scryptHasher } from "./passwords.ts";
import type { PasswordHasher } from "./passwords.ts";

const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export const SESSION_COOKIE = "bm_session";
export const SESSION_LIFETIME_MS = 30 * DAY_MS;
/** The expiry moves forward at most once a day, so an ordinary request does not write to the database. */
const SESSION_EXTEND_STEP_MS = DAY_MS;

/** Failed password checks (sign-in and the current password when changing it), R39. */
export const LIMIT_WINDOW_MS = 15 * MINUTE_MS;
export const MAX_FAILURES_PER_ADDRESS = 10;
export const MAX_FAILURES_PER_LOGIN_AND_ADDRESS = 10;
export const MAX_FAILURES_PER_LOGIN = 100;
/** Registrations with a code or open registration, successful or not, per address in LIMIT_WINDOW_MS. */
export const MAX_REGISTRATIONS_PER_ADDRESS = 10;

/** Bounds an administrator can give a registration code (R38). */
export const INVITE_MAX_USES = 1000;
export const INVITE_MAX_DAYS = 365;

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

function checkLogin(value: string): string {
  if (!LOGIN_PATTERN.test(value)) throw new ApiError("login.format");
  return value;
}

/** Up to 40 characters after trimming, not empty, no control characters. */
function checkDisplayName(value: string): string {
  const name = value.trim();
  if (name === "" || length(name) > 40 || CONTROL_CHARACTER.test(name)) throw new ApiError("name.format");
  return name;
}

function checkPassword(value: string): string {
  const size = length(value);
  if (size < 8 || size > 200) throw new ApiError("password.format");
  return value;
}

function checkWhole(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ApiError("request.format");
  return value;
}

// ---- secrets ----

/** Session tokens, registration codes and the setup token are kept only as this hash. */
const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

function readableText(size: number): string {
  // 256 is a multiple of 32, so taking the low 5 bits of each byte is uniform.
  return [...randomBytes(size)].map((byte) => READABLE[byte & 31]).join("");
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
  readonly #failuresByAddress = new AttemptLimiter(MAX_FAILURES_PER_ADDRESS, LIMIT_WINDOW_MS);
  readonly #failuresByLoginAndAddress = new AttemptLimiter(MAX_FAILURES_PER_LOGIN_AND_ADDRESS, LIMIT_WINDOW_MS);
  readonly #failuresByLogin = new AttemptLimiter(MAX_FAILURES_PER_LOGIN, LIMIT_WINDOW_MS);
  readonly #registrations = new AttemptLimiter(MAX_REGISTRATIONS_PER_ADDRESS, LIMIT_WINDOW_MS);
  readonly #hasher: PasswordHasher;
  readonly #decoy = decoyPassword();
  /** SHA-256 of the one-time setup token; the token itself is only printed. */
  #setupHash: Buffer | null = null;

  constructor(db: Database, now: () => number, hasher: PasswordHasher = scryptHasher) {
    this.#db = db;
    this.#now = now;
    this.#hasher = hasher;
  }

  /**
   * With no users in the database, makes the one-time token for creating the first administrator.
   * It lives in memory (as a hash) until it is used or the server restarts. Null when users exist.
   */
  startSetup(): string | null {
    if (this.#db.countUsers() > 0) {
      this.#setupHash = null;
      return null;
    }
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    this.#setupHash = sha256(token);
    return token;
  }

  #setupMatches(token: string): boolean {
    return this.#setupHash !== null && timingSafeEqual(sha256(token), this.#setupHash) && this.#db.countUsers() === 0;
  }

  /** Registration without a code: open registration is on, and the first administrator exists (until then only the setup link registers). */
  registrationOpen(openRegistration: boolean): boolean {
    return openRegistration && this.#db.countUsers() > 0;
  }

  async register(input: Registration, openRegistration: boolean, address: string): Promise<SignedIn> {
    const { setup, code } = input;
    const now = this.#now();
    // Every registration by code or open registration counts, successful or not.
    if (setup === undefined && !this.#registrations.take(addressKey(address), now)) {
      throw new ApiError("auth.tooManyRegistrations");
    }
    const login = checkLogin(input.login);
    const displayName = checkDisplayName(input.displayName);
    const password = checkPassword(input.password);

    const needsInvite = setup === undefined && !this.registrationOpen(openRegistration);
    const codeHash = code === undefined ? null : sha256(code);
    const refusal = setup !== undefined ? "auth.setupInvalid" : "auth.inviteInvalid";
    const allowed = (): boolean => {
      if (setup !== undefined) return this.#setupMatches(setup);
      return !needsInvite || (codeHash !== null && this.#db.hasInvite(codeHash, "register", now));
    };

    // The code is checked before the login, so without one nobody learns which logins exist.
    if (!allowed()) throw new ApiError(refusal);
    if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");

    const stored = await this.#hasher.hash(password);

    // Checked again in one transaction: other requests ran while the password was hashed.
    const user = this.#db.transaction(() => {
      if (!allowed()) throw new ApiError(refusal);
      if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");
      if (needsInvite && (codeHash === null || !this.#db.useInvite(codeHash, "register", now))) throw new ApiError(refusal);
      return this.#db.insertUser({
        login,
        displayName,
        ...stored,
        role: setup !== undefined ? "admin" : "user",
        mustChangePassword: false,
        createdAt: now,
      });
    });
    if (setup !== undefined) this.#setupHash = null;
    return { user, token: this.#newSession(user, now) };
  }

  /**
   * The same `auth.invalid` for an unknown login and a wrong password. The session is made only if the password
   * and the account did not change while the password was checked (otherwise also `auth.invalid`).
   */
  async login(login: string, password: string, address: string): Promise<SignedIn> {
    const checked = await this.#checkPassword(login, password, address, "auth.invalid");
    if (checked.disabled) throw new ApiError("auth.disabled");
    const signedIn = this.#db.transaction(() => {
      const user = this.#unchanged(checked, "auth.invalid");
      return { user, token: this.#newSession(user, this.#now()) };
    });
    if (!isCurrent(checked)) this.#db.rehashPassword(checked.id, checked.passHash, await this.#hasher.hash(password));
    return signedIn;
  }

  /**
   * The user as `checked` before the slow password check, read again: a change or reset of the password,
   * disabling or a reset flag that came in between makes the check void and throws `failure`.
   */
  #unchanged(checked: User, failure: "auth.invalid" | "password.wrong"): User {
    const user = this.#db.findUserById(checked.id);
    const same =
      user !== undefined &&
      user.passVersion === checked.passVersion &&
      user.disabled === checked.disabled &&
      user.mustChangePassword === checked.mustChangePassword;
    if (!same) throw new ApiError(failure);
    return user;
  }

  /**
   * Checks a password under the limits of R39: failures per address, per login and address, and per login
   * from all addresses. A failure throws `failure`; over a limit, `auth.tooManyAttempts`, even for the right password.
   */
  async #checkPassword(login: string, password: string, address: string, failure: "auth.invalid" | "password.wrong"): Promise<User> {
    const now = this.#now();
    const net = addressKey(address);
    const limits: [AttemptLimiter, string][] = [[this.#failuresByAddress, net]];
    // A malformed login cannot exist, and keeping it would let anyone fill memory with junk keys.
    const wellFormed = LOGIN_PATTERN.test(login);
    if (wellFormed) limits.push([this.#failuresByLoginAndAddress, `${login} ${net}`], [this.#failuresByLogin, login]);
    const booked: [AttemptLimiter, string][] = [];
    for (const [limiter, key] of limits) {
      if (!limiter.take(key, now)) {
        for (const [done, doneKey] of booked) done.giveBack(doneKey, now);
        throw new ApiError("auth.tooManyAttempts");
      }
      booked.push([limiter, key]);
    }

    const user = wellFormed ? this.#db.findUserByLogin(login) : undefined;
    const matches = await this.#hasher.matches(password, user ?? this.#decoy);
    if (!user || !matches) throw new ApiError(failure);
    for (const [limiter, key] of booked) limiter.giveBack(key, now);
    return user;
  }

  #newSession(user: User, now: number): string {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    this.#db.insertSession(sha256(token), user.id, user.passVersion, now + SESSION_LIFETIME_MS);
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
    // A session made under an older password (changed or reset since) is not valid.
    if (session.expiresAt <= now || !user || user.disabled || session.passVersion !== user.passVersion) {
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

  /** Needs the current password (under the same limits as sign-in); ends every other session of the user. */
  async changePassword(auth: Authenticated, current: string, next: string, address: string): Promise<User> {
    checkPassword(next);
    if (current === next) throw new ApiError("password.same");
    const checked = await this.#checkPassword(auth.user.login, current, address, "password.wrong");
    const stored = await this.#hasher.hash(next);
    return this.#db.transaction(() => {
      this.#unchanged(checked, "password.wrong");
      this.#db.setPassword(checked.id, stored, false);
      const user = this.#existing(checked.id);
      // This session stays, under the new password version; all others end.
      this.#db.setSessionPassVersion(auth.tokenHash, user.passVersion);
      this.#db.deleteUserSessions(user.id, auth.tokenHash);
      return user;
    });
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
    const stored = await this.#hasher.hash(password);
    const user = this.#db.transaction(() => {
      if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");
      return this.#db.insertUser({ login, displayName, ...stored, role, mustChangePassword: true, createdAt: this.#now() });
    });
    return { user, password };
  }

  /** Gives the user a temporary password that must be changed (a new password version), and ends all of their sessions. */
  async resetPassword(admin: User, id: number): Promise<{ user: User; password: string }> {
    this.#other(admin, id);
    const password = readableText(TEMPORARY_PASSWORD_LENGTH);
    const stored = await this.#hasher.hash(password);
    this.#db.transaction(() => {
      this.#existing(id);
      this.#db.setPassword(id, stored, true);
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

  /** Makes another user an administrator or takes the role away (R38); the role is read on every request. */
  setRole(admin: User, id: number, role: Role): User {
    this.#other(admin, id);
    this.#db.setRole(id, role);
    return this.#existing(id);
  }

  /** A registration code for `maxUses` registrations within `days` days (R38). Only its hash is stored. */
  createInvite(admin: User, maxUses: number, days: number): { code: string; expiresAt: number; maxUses: number } {
    checkWhole(maxUses, INVITE_MAX_USES);
    checkWhole(days, INVITE_MAX_DAYS);
    const code = readableText(INVITE_CODE_LENGTH);
    const expiresAt = this.#now() + days * DAY_MS;
    this.#db.insertInvite(sha256(code), "register", null, admin.id, expiresAt, maxUses);
    return { code, expiresAt, maxUses };
  }

  #existing(id: number): User {
    const user = this.#db.findUserById(id);
    if (!user) throw new ApiError("user.notFound");
    return user;
  }

  /** An administrator does not lock themselves out: their own account is not reset, disabled or demoted here. */
  #other(admin: User, id: number): void {
    if (id === admin.id) throw new ApiError("admin.self");
    this.#existing(id);
  }
}
