// The SQLite database (plan 6.5, R17). Every query of the server lives here; nothing else touches node:sqlite.
// The schema version is PRAGMA user_version; migrations run in order, each in its own transaction.

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

/**
 * Migration N (1-based) brings the schema from version N-1 to N. Once a release with a migration is installed
 * anywhere, that migration is never edited again: a schema change becomes the next migration. Migration 1 was
 * still changed in place during stage 4, because no database existed yet.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    pass_hash BLOB NOT NULL,
    pass_salt BLOB NOT NULL,
    pass_params TEXT NOT NULL,
    pass_version INTEGER NOT NULL DEFAULT 1,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    pass_version INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_by_user ON sessions (user_id);

  CREATE TABLE invites (
    code_hash BLOB PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('register', 'game')),
    game_id INTEGER,
    created_by INTEGER NOT NULL REFERENCES users (id),
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL CHECK (max_uses >= 1),
    uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0)
  ) STRICT;
  `,
  // Stage 5: games, their members and scenes (plan 5.11, 6.5). A personal campaign has no master (gm_id NULL);
  // scenes.version counts the saved changes of state_json.
  `
  CREATE TABLE games (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('gm', 'personal')),
    owner_id INTEGER NOT NULL REFERENCES users (id),
    gm_id INTEGER REFERENCES users (id),
    active_scene_id INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE members (
    game_id INTEGER NOT NULL REFERENCES games (id),
    user_id INTEGER NOT NULL REFERENCES users (id),
    role TEXT NOT NULL CHECK (role IN ('gm', 'player')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, user_id)
  ) STRICT;
  CREATE INDEX members_by_user ON members (user_id);

  CREATE TABLE scenes (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games (id),
    name TEXT NOT NULL,
    visible INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0, 1)),
    state_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX scenes_by_game ON scenes (game_id);
  `,
  // Stage 26b (R50): an invite gets an id, so an administrator revokes it from the list without its code.
  // AUTOINCREMENT, so the id of a revoked or used-up code never comes back as the id of a new one. Codes that R50
  // would have deleted already go now: all codes of a disabled user, and the registration codes of someone who is
  // no longer an administrator (only administrators make them), so enabling them or giving the role back revives nothing.
  // Game invites of someone who is not an administrator stay: the database does not tell a former administrator from
  // a master who never was one, and the invites of such a master are not R50's to delete.
  // `registers`: the code was made by an active administrator, so it may register newcomers (R43) while its creator
  // still is one (R49). Set when the code is made; here, for the codes kept, from the creator's role now, so the game
  // invite of a former administrator never registers again, even when the role comes back.
  `
  DELETE FROM invites WHERE created_by IN (SELECT id FROM users WHERE disabled = 1)
    OR (kind = 'register' AND created_by IN (SELECT id FROM users WHERE role <> 'admin'));

  CREATE TABLE invites_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash BLOB NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('register', 'game')),
    game_id INTEGER,
    created_by INTEGER NOT NULL REFERENCES users (id),
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL CHECK (max_uses >= 1),
    uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
    registers INTEGER NOT NULL DEFAULT 0 CHECK (registers IN (0, 1))
  ) STRICT;
  INSERT INTO invites_new (code_hash, kind, game_id, created_by, expires_at, max_uses, uses, registers)
    SELECT code_hash, kind, game_id, created_by, expires_at, max_uses, uses,
      coalesce((SELECT users.role = 'admin' AND users.disabled = 0 FROM users WHERE users.id = invites.created_by), 0)
    FROM invites ORDER BY rowid;
  DROP TABLE invites;
  ALTER TABLE invites_new RENAME TO invites;
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
  /** How pass_hash was made, e.g. `scrypt:32768:8:1` (auth.ts), so the cost can be raised later. */
  passParams: string;
  /** Goes up with every new password (change or reset); a session made under another version is not valid. */
  passVersion: number;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  /** JSON text of the account settings (language, theme). */
  settingsJson: string;
  createdAt: number;
}

/** A password as kept in the database: never the password itself. */
export interface StoredPassword {
  passHash: Uint8Array;
  passSalt: Uint8Array;
  /** How pass_hash was made, e.g. `scrypt:32768:8:1` (auth.ts), so the cost can be raised later. */
  passParams: string;
}

export interface NewUser extends StoredPassword {
  login: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  createdAt: number;
}

export interface Session {
  userId: number;
  /** The user's password version when the session was made. */
  passVersion: number;
  expiresAt: number;
}

/** A game with a master, or a personal campaign of its owner (plan 5.11, R24). */
export type GameKind = "gm" | "personal";
export type MemberRole = "gm" | "player";

export interface Game {
  id: number;
  title: string;
  kind: GameKind;
  ownerId: number;
  /** Null in a personal campaign until the owner names a master. */
  gmId: number | null;
  activeSceneId: number | null;
  createdAt: number;
}

/** A game in the list of a user's games, with the user's role in it. */
export interface MyGame extends Game {
  role: MemberRole;
}

export interface Member {
  userId: number;
  displayName: string;
  role: MemberRole;
  joinedAt: number;
}

export interface SceneInfo {
  id: number;
  gameId: number;
  name: string;
  visible: boolean;
  /** Goes up with every saved change of the scene state. */
  version: number;
  updatedAt: number;
}

export interface SceneRecord extends SceneInfo {
  /** The scene (plan 6.1) as JSON text. */
  stateJson: string;
}

export interface Invite {
  kind: InviteKind;
  /** The game of a game invite, null for a registration code. */
  gameId: number | null;
  createdBy: number;
  /**
   * The code registers newcomers: an active administrator made it (R43), and its creator is an administrator and not
   * disabled now (R49). A game invite made before its creator became an administrator never registers.
   */
  registers: boolean;
  expiresAt: number;
  uses: number;
  maxUses: number;
}

/** A code that still lets someone in, as the administrator's list shows it (R50); never the code or its hash. */
export interface ActiveInvite {
  id: number;
  kind: InviteKind;
  /** The display name of the creator. */
  creatorName: string;
  /** The title of the game of a game invite, null for a registration code. */
  gameTitle: string | null;
  usesLeft: number;
  expiresAt: number;
}

type Row = Record<string, SQLOutputValue>;

function toGame(row: Row): Game {
  return {
    id: Number(row.id),
    title: String(row.title),
    kind: row.kind === "personal" ? "personal" : "gm",
    ownerId: Number(row.owner_id),
    gmId: row.gm_id === null ? null : Number(row.gm_id),
    activeSceneId: row.active_scene_id === null ? null : Number(row.active_scene_id),
    createdAt: Number(row.created_at),
  };
}

const toRole = (value: SQLOutputValue): MemberRole => (value === "gm" ? "gm" : "player");

function toSceneInfo(row: Row): SceneInfo {
  return {
    id: Number(row.id),
    gameId: Number(row.game_id),
    name: String(row.name),
    visible: row.visible === 1,
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
  };
}

function toUser(row: Row): User {
  return {
    id: Number(row.id),
    login: String(row.login),
    displayName: String(row.display_name),
    passHash: row.pass_hash as Uint8Array,
    passSalt: row.pass_salt as Uint8Array,
    passParams: String(row.pass_params),
    passVersion: Number(row.pass_version),
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
      `INSERT INTO users (login, display_name, pass_hash, pass_salt, pass_params, role, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      user.login,
      user.displayName,
      user.passHash,
      user.passSalt,
      user.passParams,
      user.role,
      flag(user.mustChangePassword),
      user.createdAt,
    );
    if (!row) throw new Error("INSERT ... RETURNING gave no row");
    return toUser(row);
  }

  /** A new password: the password version goes up, so sessions made under the old one stop being valid. */
  setPassword(id: number, password: StoredPassword, mustChangePassword: boolean): void {
    this.#run(
      `UPDATE users SET pass_hash = ?, pass_salt = ?, pass_params = ?, must_change_password = ?, pass_version = pass_version + 1
       WHERE id = ?`,
      password.passHash,
      password.passSalt,
      password.passParams,
      flag(mustChangePassword),
      id,
    );
  }

  /**
   * The same password hashed with the current parameters; the version stays. Only if the hash is still `oldHash`,
   * so a change or reset that came in between is not overwritten.
   */
  rehashPassword(id: number, oldHash: Uint8Array, password: StoredPassword): void {
    this.#run(
      "UPDATE users SET pass_hash = ?, pass_salt = ?, pass_params = ? WHERE id = ? AND pass_hash = ?",
      password.passHash,
      password.passSalt,
      password.passParams,
      id,
      oldHash,
    );
  }

  setRole(id: number, role: Role): void {
    this.#run("UPDATE users SET role = ? WHERE id = ?", role, id);
  }

  setDisabled(id: number, disabled: boolean): void {
    this.#run("UPDATE users SET disabled = ? WHERE id = ?", flag(disabled), id);
  }

  setSettings(id: number, settingsJson: string): void {
    this.#run("UPDATE users SET settings_json = ? WHERE id = ?", settingsJson, id);
  }

  // ---- sessions: only the SHA-256 of the token is stored ----

  insertSession(tokenHash: Uint8Array, userId: number, passVersion: number, expiresAt: number): void {
    this.#run(
      "INSERT INTO sessions (token_hash, user_id, pass_version, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      userId,
      passVersion,
      expiresAt,
    );
  }

  /** Moves the session doing a password change to the new password version. */
  setSessionPassVersion(tokenHash: Uint8Array, passVersion: number): void {
    this.#run("UPDATE sessions SET pass_version = ? WHERE token_hash = ?", passVersion, tokenHash);
  }

  findSession(tokenHash: Uint8Array): Session | undefined {
    const row = this.#get("SELECT user_id, pass_version, expires_at FROM sessions WHERE token_hash = ?", tokenHash);
    return row && { userId: Number(row.user_id), passVersion: Number(row.pass_version), expiresAt: Number(row.expires_at) };
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

  // ---- invites: only the SHA-256 of the code is stored ----

  /**
   * A new code. Whether it may register newcomers (`registers`) is read from its creator in the same statement: only
   * a code made by an active administrator may (R43).
   */
  insertInvite(codeHash: Uint8Array, kind: InviteKind, gameId: number | null, createdBy: number, expiresAt: number, maxUses: number): void {
    this.#run(
      `INSERT INTO invites (code_hash, kind, game_id, created_by, expires_at, max_uses, registers)
       VALUES (?, ?, ?, ?, ?, ?, coalesce((SELECT role = 'admin' AND disabled = 0 FROM users WHERE id = ?), 0))`,
      codeHash,
      kind,
      gameId,
      createdBy,
      expiresAt,
      maxUses,
      createdBy,
    );
  }

  /** Uses the invite once, in one statement, so parallel requests never exceed max_uses; false when it cannot be used. */
  useInvite(codeHash: Uint8Array, kind: InviteKind, now: number): boolean {
    const changed = this.#run(
      "UPDATE invites SET uses = uses + 1 WHERE code_hash = ? AND kind = ? AND expires_at > ? AND uses < max_uses",
      codeHash,
      kind,
      now,
    );
    return changed === 1;
  }

  /**
   * An invite of either kind by the hash of its code, also when it has expired or has no uses left, with whether it
   * registers newcomers now: one read whatever the code is, so the time of a registration tells nothing.
   */
  findInvite(codeHash: Uint8Array): Invite | undefined {
    const row = this.#get(
      `SELECT invites.*, invites.registers = 1 AND users.role = 'admin' AND users.disabled = 0 AS registers_now
       FROM invites LEFT JOIN users ON users.id = invites.created_by WHERE invites.code_hash = ?`,
      codeHash,
    );
    return (
      row && {
        kind: row.kind === "game" ? "game" : "register",
        gameId: row.game_id === null ? null : Number(row.game_id),
        createdBy: Number(row.created_by),
        registers: row.registers_now === 1,
        expiresAt: Number(row.expires_at),
        uses: Number(row.uses),
        maxUses: Number(row.max_uses),
      }
    );
  }

  deleteGameInvites(gameId: number): void {
    this.#run("DELETE FROM invites WHERE kind = 'game' AND game_id = ?", gameId);
  }

  /** Deletes every code the user made, registration codes and game invites (R50). */
  deleteUserInvites(userId: number): void {
    this.#run("DELETE FROM invites WHERE created_by = ?", userId);
  }

  /** Deletes one code by its id; false when there is none. */
  deleteInvite(id: number): boolean {
    return this.#run("DELETE FROM invites WHERE id = ?", id) === 1;
  }

  /** Deletes one invite of this game by its id (R52); false when the game has none with that id. */
  deleteGameInvite(gameId: number, id: number): boolean {
    return this.#run("DELETE FROM invites WHERE id = ? AND kind = 'game' AND game_id = ?", id, gameId) === 1;
  }

  /**
   * The codes that are not expired and have uses left, newest first: of both kinds (R50), or only the invites of
   * one game when `gameId` is given (R52).
   */
  listActiveInvites(now: number, gameId: number | null = null): ActiveInvite[] {
    return this.#all(
      `SELECT invites.id, invites.kind, users.display_name, games.title, invites.max_uses - invites.uses AS uses_left, invites.expires_at
       FROM invites JOIN users ON users.id = invites.created_by LEFT JOIN games ON games.id = invites.game_id
       WHERE invites.expires_at > ? AND invites.uses < invites.max_uses AND (? IS NULL OR (invites.kind = 'game' AND invites.game_id = ?))
       ORDER BY invites.id DESC`,
      now,
      gameId,
      gameId,
    ).map((row) => ({
      id: Number(row.id),
      kind: row.kind === "game" ? "game" : "register",
      creatorName: String(row.display_name),
      gameTitle: row.title === null ? null : String(row.title),
      usesLeft: Number(row.uses_left),
      expiresAt: Number(row.expires_at),
    }));
  }

  // ---- games and members ----

  insertGame(title: string, kind: GameKind, ownerId: number, gmId: number | null, createdAt: number): Game {
    const row = this.#get(
      "INSERT INTO games (title, kind, owner_id, gm_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
      title,
      kind,
      ownerId,
      gmId,
      createdAt,
    );
    if (!row) throw new Error("INSERT ... RETURNING gave no row");
    return toGame(row);
  }

  findGame(id: number): Game | undefined {
    const row = this.#get("SELECT * FROM games WHERE id = ?", id);
    return row && toGame(row);
  }

  /** The games the user is a member of, newest first. */
  listUserGames(userId: number): MyGame[] {
    return this.#all(
      `SELECT games.*, members.role AS member_role FROM games JOIN members ON members.game_id = games.id
       WHERE members.user_id = ? ORDER BY games.created_at DESC, games.id DESC`,
      userId,
    ).map((row) => ({ ...toGame(row), role: toRole(row.member_role) }));
  }

  /** Null leaves a personal campaign without a master. */
  setGameMaster(gameId: number, gmId: number | null): void {
    this.#run("UPDATE games SET gm_id = ? WHERE id = ?", gmId, gameId);
  }

  setActiveScene(gameId: number, sceneId: number): void {
    this.#run("UPDATE games SET active_scene_id = ? WHERE id = ?", sceneId, gameId);
  }

  /** The game with its members, scenes and invites. */
  deleteGame(gameId: number): void {
    this.deleteGameInvites(gameId);
    this.#run("DELETE FROM scenes WHERE game_id = ?", gameId);
    this.#run("DELETE FROM members WHERE game_id = ?", gameId);
    this.#run("DELETE FROM games WHERE id = ?", gameId);
  }

  findMemberRole(gameId: number, userId: number): MemberRole | undefined {
    const row = this.#get("SELECT role FROM members WHERE game_id = ? AND user_id = ?", gameId, userId);
    return row && toRole(row.role);
  }

  listMembers(gameId: number): Member[] {
    return this.#all(
      `SELECT members.user_id, users.display_name, members.role, members.joined_at FROM members
       JOIN users ON users.id = members.user_id WHERE members.game_id = ? ORDER BY members.joined_at, members.user_id`,
      gameId,
    ).map((row) => ({
      userId: Number(row.user_id),
      displayName: String(row.display_name),
      role: toRole(row.role),
      joinedAt: Number(row.joined_at),
    }));
  }

  /** Adds a member; false when the user already is one (nothing changes then). */
  insertMember(gameId: number, userId: number, role: MemberRole, joinedAt: number): boolean {
    const changed = this.#run(
      "INSERT INTO members (game_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      gameId,
      userId,
      role,
      joinedAt,
    );
    return changed === 1;
  }

  setMemberRole(gameId: number, userId: number, role: MemberRole): void {
    this.#run("UPDATE members SET role = ? WHERE game_id = ? AND user_id = ?", role, gameId, userId);
  }

  deleteMember(gameId: number, userId: number): void {
    this.#run("DELETE FROM members WHERE game_id = ? AND user_id = ?", gameId, userId);
  }

  // ---- scenes ----

  insertScene(gameId: number, name: string, stateJson: string, updatedAt: number): SceneInfo {
    const row = this.#get(
      "INSERT INTO scenes (game_id, name, state_json, updated_at) VALUES (?, ?, ?, ?) RETURNING *",
      gameId,
      name,
      stateJson,
      updatedAt,
    );
    if (!row) throw new Error("INSERT ... RETURNING gave no row");
    return toSceneInfo(row);
  }

  /** A scene of this game; a scene of another game is not found. */
  findScene(gameId: number, sceneId: number): SceneRecord | undefined {
    const row = this.#get("SELECT * FROM scenes WHERE id = ? AND game_id = ?", sceneId, gameId);
    return row && { ...toSceneInfo(row), stateJson: String(row.state_json) };
  }

  /** The scenes of a game without their state, oldest first. */
  listScenes(gameId: number): SceneInfo[] {
    return this.#all("SELECT id, game_id, name, visible, version, updated_at FROM scenes WHERE game_id = ? ORDER BY id", gameId).map(
      toSceneInfo,
    );
  }

  renameScene(sceneId: number, name: string): void {
    this.#run("UPDATE scenes SET name = ? WHERE id = ?", name, sceneId);
  }

  setSceneVisible(sceneId: number, visible: boolean): void {
    this.#run("UPDATE scenes SET visible = ? WHERE id = ?", flag(visible), sceneId);
  }

  /** Saves a changed state with its version (the number of changes made to it, written or not). */
  saveSceneState(sceneId: number, stateJson: string, version: number, updatedAt: number): void {
    if (this.#run("UPDATE scenes SET state_json = ?, version = ?, updated_at = ? WHERE id = ?", stateJson, version, updatedAt, sceneId) !== 1) {
      throw new Error(`scene ${sceneId} is missing`);
    }
  }

  /**
   * Drops expired sessions, invites with no uses left and expired registration codes. An expired game invite
   * stays, so joining with it keeps answering 410 after a restart; it goes with its game or when a member is removed.
   */
  deleteExpired(now: number): void {
    this.#run("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.#run("DELETE FROM invites WHERE uses >= max_uses OR (expires_at <= ? AND kind = 'register')", now);
  }
}
