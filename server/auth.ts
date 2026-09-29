// Accounts, sessions, registration and the limits on password guessing (plan 5.10, 6.2, R11, R18, R38, R39).
// Knows nothing about HTTP: the routes in app.ts pass values in and turn ApiError into a response.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { isLang } from "../client/src/i18n/index.ts";
import type { LANGS } from "../client/src/i18n/index.ts";
import { isHexColor, isThemeChoice } from "../client/src/theme.ts";
import type { THEME_CHOICES } from "../client/src/theme.ts";
import type { ActiveInvite, Database, Role, Session, User } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { ErrorCode } from "./errors.ts";
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

/** A name (of a user, game or scene): up to 40 characters after trimming, not empty, no control characters; else `error`. */
export function checkName(value: string, error: ErrorCode): string {
  const name = value.trim();
  if (name === "" || length(name) > 40 || CONTROL_CHARACTER.test(name)) throw new ApiError(error);
  return name;
}

const checkDisplayName = (value: string): string => checkName(value, "name.format");

function checkPassword(value: string): string {
  const size = length(value);
  if (size < 8 || size > 200) throw new ApiError("password.format");
  return value;
}

export function checkWhole(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ApiError("request.format");
  return value;
}

// ---- secrets ----

/** Session tokens, registration and game codes and the setup token are kept only as this hash. */
export const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

function readableText(size: number): string {
  // 256 is a multiple of 32, so taking the low 5 bits of each byte is uniform.
  return [...randomBytes(size)].map((byte) => READABLE[byte & 31]).join("");
}

/** A new code for a registration or game invite: 16 readable characters, 80 random bits. */
export const newInviteCode = (): string => readableText(INVITE_CODE_LENGTH);

// ---- account settings (plan 5.15) ----

export interface AccountSettings {
  lang?: (typeof LANGS)[number];
  theme?: (typeof THEME_CHOICES)[number];
  /** The user's own colours of the void around the map and of the grid over it (R45), `#rrggbb` in lowercase. */
  voidColor?: string;
  gridColor?: string;
  /** The tool column shows the names beside the icons (R45). */
  toolsExpanded?: boolean;
}

type ColorKey = "voidColor" | "gridColor";

/** A change of the settings; a colour set to null goes back to the theme's. */
export type SettingsChange = Omit<AccountSettings, ColorKey> & { [K in ColorKey]?: string | null };

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
  if ("voidColor" in value && isHexColor(value.voidColor)) settings.voidColor = value.voidColor;
  if ("gridColor" in value && isHexColor(value.gridColor)) settings.gridColor = value.gridColor;
  if ("toolsExpanded" in value && typeof value.toolsExpanded === "boolean") settings.toolsExpanded = value.toolsExpanded;
  return settings;
}

/** Checks a settings change: only known keys with known values. */
export function checkSettings(input: Record<string, unknown>): SettingsChange {
  const change: SettingsChange = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "lang" && isLang(value)) change.lang = value;
    else if (key === "theme" && isThemeChoice(value)) change.theme = value;
    else if ((key === "voidColor" || key === "gridColor") && (value === null || isHexColor(value))) change[key] = value?.toLowerCase() ?? null;
    else if (key === "toolsExpanded" && typeof value === "boolean") change.toolsExpanded = value;
    else throw new ApiError("request.format");
  }
  return change;
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

export interface Registered extends SignedIn {
  /** The game the user became a player of by an administrator's game invite (R43), else null. */
  gameId: number | null;
}

/** A code that lets a registration in: a registration code (no game) or an administrator's game invite. */
interface Grant {
  codeHash: Buffer;
  gameId: number | null;
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
  /** A registration code, or a game invite of an administrator (R43). */
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

  /**
   * Registers with the setup token, with open registration, or else with a code made by someone who is an active
   * administrator at this moment (R43, R49): a registration code, or a game invite, which also makes the user a player of
   * its game and uses the invite once, in the same transaction as the account. Any other game invite, and a code
   * used up, answer as an unknown code (`auth.inviteInvalid`); an administrator's expired game invite is 410.
   * With open registration a code is not used: the user joins the game by its button later.
   */
  async register(input: Registration, openRegistration: boolean, address: string): Promise<Registered> {
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
    /** What lets the user in; null when no code is needed. Throws the refusal. */
    const grant = (): Grant | null => {
      if (setup !== undefined) {
        if (!this.#setupMatches(setup)) throw new ApiError("auth.setupInvalid");
        return null;
      }
      if (!needsInvite) return null;
      if (code === undefined) throw new ApiError("auth.inviteInvalid");
      return this.#grantOf(sha256(code), now);
    };

    // The code is checked before the login, so without one nobody learns which logins exist.
    grant();
    if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");

    const stored = await this.#hasher.hash(password);

    // Checked again in one transaction: other requests ran while the password was hashed (a use of the code,
    // a change of its creator's role). A failure anywhere leaves neither the account nor the membership.
    const { user, gameId } = this.#db.transaction(() => {
      const granted = grant();
      if (this.#db.findUserByLogin(login)) throw new ApiError("login.taken");
      if (granted && !this.#db.useInvite(granted.codeHash, granted.gameId === null ? "register" : "game", now)) {
        throw new ApiError("auth.inviteInvalid");
      }
      const created = this.#db.insertUser({
        login,
        displayName,
        ...stored,
        role: setup !== undefined ? "admin" : "user",
        mustChangePassword: false,
        createdAt: now,
      });
      const joined = granted?.gameId ?? null;
      if (joined !== null) this.#db.insertMember(joined, created.id, "player", now);
      return { user: created, gameId: joined };
    });
    if (setup !== undefined) this.#setupHash = null;
    return { user, token: this.#newSession(user, now), gameId };
  }

  /**
   * What a code gives a registration; throws for a code that gives nothing (see register). Any code, known or not,
   * costs the same one read of the database (the invite with its creator), so the answer time gives nothing away.
   */
  #grantOf(codeHash: Buffer, now: number): Grant {
    const invite = this.#db.findInvite(codeHash);
    // A code works only while its creator is an active administrator (R43, R49); nothing tells the code of someone
    // else from an unknown one, not even its expiry.
    if (!invite || !invite.creatorIsAdmin) throw new ApiError("auth.inviteInvalid");
    if (invite.kind === "register") {
      if (invite.expiresAt <= now || invite.uses >= invite.maxUses) throw new ApiError("auth.inviteInvalid");
      return { codeHash, gameId: null };
    }
    // As when joining (stage 5): a used-up invite is like an unknown one, an expired one is 410.
    if (invite.gameId === null || invite.uses >= invite.maxUses) throw new ApiError("auth.inviteInvalid");
    if (invite.expiresAt <= now) throw new ApiError("invite.expired");
    return { codeHash, gameId: invite.gameId };
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
    const found = this.#liveSession(tokenHash);
    if (!found) return null;
    const { session, user } = found;
    const now = this.#now();
    const extended = session.expiresAt < now + SESSION_LIFETIME_MS - SESSION_EXTEND_STEP_MS;
    if (extended) this.#db.setSessionExpiry(tokenHash, now + SESSION_LIFETIME_MS);
    return { user, token, tokenHash, extended };
  }

  /** Whether the session is still valid, without extending it (an open event stream asks this now and then). */
  sessionAlive(tokenHash: Buffer): boolean {
    return this.#liveSession(tokenHash) !== null;
  }

  /** The session and its user; an expired session, or one of a disabled user, is deleted and gives null. */
  #liveSession(tokenHash: Buffer): { session: Session; user: User } | null {
    const session = this.#db.findSession(tokenHash);
    if (!session) return null;
    const user = this.#db.findUserById(session.userId);
    // A session made under an older password (changed or reset since) is not valid.
    if (session.expiresAt <= this.#now() || !user || user.disabled || session.passVersion !== user.passVersion) {
      this.#db.deleteSession(tokenHash);
      return null;
    }
    return { session, user };
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

  saveSettings(user: User, change: SettingsChange): AccountSettings {
    const { voidColor, gridColor, ...rest } = change;
    const settings: AccountSettings = { ...parseSettings(user.settingsJson), ...rest };
    for (const [key, value] of [["voidColor", voidColor], ["gridColor", gridColor]] as const) {
      if (value === null) delete settings[key];
      else if (value !== undefined) settings[key] = value;
    }
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

  /**
   * Disabling also ends all sessions of the user and deletes every code they made, registration codes and game
   * invites (R50), in the same transaction. Enabling gives none of them back.
   */
  setDisabled(admin: User, id: number, disabled: boolean): User {
    this.#other(admin, id);
    this.#db.transaction(() => {
      this.#db.setDisabled(id, disabled);
      if (disabled) {
        this.#db.deleteUserSessions(id);
        this.#db.deleteUserInvites(id);
      }
    });
    return this.#existing(id);
  }

  /**
   * Makes another user an administrator or takes the role away (R38); the role is read on every request. Taking it
   * away deletes the registration codes the user made, in the same transaction (R50); their game invites stay, since
   * they stay the master, and no longer register newcomers (R43, R49). Giving the role back gives no code back.
   */
  setRole(admin: User, id: number, role: Role): User {
    this.#other(admin, id);
    this.#db.transaction(() => {
      this.#db.setRole(id, role);
      if (role === "user") this.#db.deleteUserInvites(id, "register");
    });
    return this.#existing(id);
  }

  /** A registration code for `maxUses` registrations within `days` days (R38). Only its hash is stored. */
  createInvite(admin: User, maxUses: number, days: number): { code: string; expiresAt: number; maxUses: number } {
    checkWhole(maxUses, INVITE_MAX_USES);
    checkWhole(days, INVITE_MAX_DAYS);
    const code = newInviteCode();
    const expiresAt = this.#now() + days * DAY_MS;
    this.#db.insertInvite(sha256(code), "register", null, admin.id, expiresAt, maxUses);
    return { code, expiresAt, maxUses };
  }

  /** The registration codes and game invites of all games that still let someone in (R50), without the codes. */
  listInvites(): ActiveInvite[] {
    return this.#db.listActiveInvites(this.#now());
  }

  /** Deletes a code of either kind by its id (R50); `admin.inviteNotFound` when there is none. */
  revokeInvite(id: number): void {
    if (!this.#db.deleteInvite(id)) throw new ApiError("admin.inviteNotFound");
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
