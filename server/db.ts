// The SQLite database (plan 6.5, R17). Every query of the server lives here; nothing else touches node:sqlite.
// The schema version is PRAGMA user_version; migrations run in order, each in its own transaction.

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

/** Migration N (1-based) brings the schema from version N-1 to N. Never edit a published one: add the next. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    pass_hash BLOB NOT NULL,
    pass_salt BLOB NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_by_user ON sessions (user_id);

  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('register', 'game')),
    game_id INTEGER,
    created_by INTEGER NOT NULL REFERENCES users (id),
    expires_at INTEGER NOT NULL
  ) STRICT;
  `,
];

/** Brings the schema up to `migrations.length`; refuses a database written by a newer server. */
export function runMigrations(db: DatabaseSync, migrations: readonly string[]): void {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > migrations.length) {
    throw new Error(`the database has schema version ${version}, this server knows up to ${migrations.length}`);
  }
  for (let next = version + 1; next <= migrations.length; next++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[next - 1]);
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}

export type Role = "admin" | "user";
export type InviteKind = "register" | "game";

export interface User {
  id: number;
  login: string;
  displayName: string;
  passHash: Uint8Array;
  passSalt: Uint8Array;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  /** JSON text of the account settings (language, theme). */
  settingsJson: string;
  createdAt: number;
}

export interface NewUser {
  login: string;
  displayName: string;
  passHash: Uint8Array;
  passSalt: Uint8Array;
  role: Role;
  mustChangePassword: boolean;
  createdAt: number;
}

export interface Session {
  userId: number;
  expiresAt: number;
}

type Row = Record<string, SQLOutputValue>;

function toUser(row: Row): User {
  return {
    id: Number(row.id),
    login: String(row.login),
    displayName: String(row.display_name),
    passHash: row.pass_hash as Uint8Array,
    passSalt: row.pass_salt as Uint8Array,
    role: row.role === "admin" ? "admin" : "user",
    mustChangePassword: row.must_change_password === 1,
    disabled: row.disabled === 1,
    settingsJson: String(row.settings_json),
    createdAt: Number(row.created_at),
  };
}

const flag = (value: boolean): number => (value ? 1 : 0);

export class Database {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  /** Opens (or creates) the database file and brings its schema up to date. */
  constructor(file: string) {
    this.#db = new DatabaseSync(file, { timeout: 5000 });
    try {
      runMigrations(this.#db, MIGRATIONS);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Runs `body` in one transaction. `body` must be synchronous. */
  transaction<T>(body: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#statement(sql).get(...params);
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#statement(sql).all(...params);
  }

  #run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#statement(sql).run(...params).changes);
  }

  // ---- users ----

  countUsers(): number {
    return Number(this.#get("SELECT count(*) AS n FROM users")?.n ?? 0);
  }

  findUserById(id: number): User | undefined {
    const row = this.#get("SELECT * FROM users WHERE id = ?", id);
    return row && toUser(row);
  }

  findUserByLogin(login: string): User | undefined {
    const row = this.#get("SELECT * FROM users WHERE login = ?", login);
    return row && toUser(row);
  }

  listUsers(): User[] {
    return this.#all("SELECT * FROM users ORDER BY id").map(toUser);
  }

  insertUser(user: NewUser): User {
    const row = this.#get(
      `INSERT INTO users (login, display_name, pass_hash, pass_salt, role, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      user.login,
      user.displayName,
      user.passHash,
      user.passSalt,
      user.role,
      flag(user.mustChangePassword),
      user.createdAt,
    );
    if (!row) throw new Error("INSERT ... RETURNING gave no row");
    return toUser(row);
  }

  setPassword(id: number, passHash: Uint8Array, passSalt: Uint8Array, mustChangePassword: boolean): void {
    this.#run(
      "UPDATE users SET pass_hash = ?, pass_salt = ?, must_change_password = ? WHERE id = ?",
      passHash,
      passSalt,
      flag(mustChangePassword),
      id,
    );
  }

  setDisabled(id: number, disabled: boolean): void {
    this.#run("UPDATE users SET disabled = ? WHERE id = ?", flag(disabled), id);
  }

  setSettings(id: number, settingsJson: string): void {
    this.#run("UPDATE users SET settings_json = ? WHERE id = ?", settingsJson, id);
  }

  // ---- sessions: only the SHA-256 of the token is stored ----

  insertSession(tokenHash: Uint8Array, userId: number, expiresAt: number): void {
    this.#run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", tokenHash, userId, expiresAt);
  }

  findSession(tokenHash: Uint8Array): Session | undefined {
    const row = this.#get("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", tokenHash);
    return row && { userId: Number(row.user_id), expiresAt: Number(row.expires_at) };
  }

  setSessionExpiry(tokenHash: Uint8Array, expiresAt: number): void {
    this.#run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", expiresAt, tokenHash);
  }

  deleteSession(tokenHash: Uint8Array): void {
    this.#run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  /** Deletes every session of the user, except `keep` when given (the session doing the change). */
  deleteUserSessions(userId: number, keep?: Uint8Array): void {
    if (keep) this.#run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", userId, keep);
    else this.#run("DELETE FROM sessions WHERE user_id = ?", userId);
  }

  // ---- invites ----

  insertInvite(code: string, kind: InviteKind, gameId: number | null, createdBy: number, expiresAt: number): void {
    this.#run(
      "INSERT INTO invites (code, kind, game_id, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
      code,
      kind,
      gameId,
      createdBy,
      expiresAt,
    );
  }

  hasInvite(code: string, kind: InviteKind, now: number): boolean {
    return this.#get("SELECT 1 AS found FROM invites WHERE code = ? AND kind = ? AND expires_at > ?", code, kind, now) !== undefined;
  }

  /** Uses up an unexpired invite; false when there is no such invite. */
  takeInvite(code: string, kind: InviteKind, now: number): boolean {
    return this.#run("DELETE FROM invites WHERE code = ? AND kind = ? AND expires_at > ?", code, kind, now) === 1;
  }

  /** Drops expired sessions and invites. */
  deleteExpired(now: number): void {
    this.#run("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.#run("DELETE FROM invites WHERE expires_at <= ?", now);
  }
}
