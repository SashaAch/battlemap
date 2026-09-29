// The database schema and its migrations (plan 6.5, 7, 8.4).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";

import { Database, MIGRATIONS, runMigrations } from "../server/db.ts";

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bm-db-"));
  file = path.join(dir, "battlemap.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inspect(): { version: number; schema: unknown[] } {
  const db = new DatabaseSync(file);
  try {
    return {
      version: Number(db.prepare("PRAGMA user_version").get()?.user_version),
      schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
    };
  } finally {
    db.close();
  }
}

const TABLE_COLUMNS = {
  users: ["id", "login", "display_name", "pass_hash", "pass_salt", "pass_params", "pass_version", "role", "must_change_password", "disabled", "settings_json", "created_at"],
  sessions: ["token_hash", "user_id", "pass_version", "expires_at"],
  invites: ["id", "code_hash", "kind", "game_id", "created_by", "expires_at", "max_uses", "uses"],
  games: ["id", "title", "kind", "owner_id", "gm_id", "active_scene_id", "created_at"],
  members: ["game_id", "user_id", "role", "joined_at"],
  scenes: ["id", "game_id", "name", "visible", "state_json", "version", "updated_at"],
};

/** A user row as migration 1 made it; test data, not a real password hash. */
function insertRawUser(db: DatabaseSync, login: string): void {
  db.prepare(
    `INSERT INTO users (login, display_name, pass_hash, pass_salt, pass_params, role, created_at)
     VALUES (?, ?, zeroblob(64), zeroblob(16), 'scrypt:32768:8:1', 'user', 1)`,
  ).run(login, login.toUpperCase());
}

describe("migrations", () => {
  test("a version 0 database reaches the last version with the tables of plan 6.5", () => {
    new DatabaseSync(file).close();
    assert.equal(inspect().version, 0);

    new Database(file).close();

    assert.equal(inspect().version, 3);
    assert.equal(MIGRATIONS.length, 3);
    const db = new DatabaseSync(file);
    try {
      for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
        const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
        assert.deepEqual(actual, columns, table);
      }
    } finally {
      db.close();
    }
  });

  test("a version 1 database with users and codes reaches version 2 without losing them", () => {
    const old = new DatabaseSync(file);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    insertRawUser(old, "anna");
    insertRawUser(old, "boris");
    old.prepare("INSERT INTO invites (code_hash, kind, created_by, expires_at, max_uses) VALUES (zeroblob(32), 'register', 1, 100, 3)").run();
    const users = old.prepare("SELECT * FROM users ORDER BY id").all();
    const invites = old.prepare("SELECT * FROM invites").all();
    old.close();
    assert.equal(inspect().version, 1);

    const upgrade = (): void => {
      const db = new DatabaseSync(file);
      try {
        runMigrations(db, MIGRATIONS.slice(0, 2));
      } finally {
        db.close();
      }
    };
    upgrade();
    const upgraded = inspect();
    assert.equal(upgraded.version, 2);
    const after = new DatabaseSync(file);
    try {
      assert.deepEqual(after.prepare("SELECT * FROM users ORDER BY id").all(), users);
      assert.deepEqual(after.prepare("SELECT * FROM invites").all(), invites);
      assert.deepEqual(after.prepare("SELECT * FROM games").all(), []);
    } finally {
      after.close();
    }

    upgrade();
    assert.deepEqual(inspect(), upgraded, "a second run changes nothing");
  });

  test("a version 2 database reaches version 3: codes get ids in their order, and the codes R50 deletes go", () => {
    const old = new DatabaseSync(file);
    runMigrations(old, MIGRATIONS.slice(0, 2));
    const people: [string, "admin" | "user", number][] = [
      ["admin", "admin", 0],
      ["demoted", "user", 0],
      ["gone_admin", "admin", 1],
      ["master", "user", 0],
      ["gone_master", "user", 1],
    ];
    for (const [login, role, disabled] of people) {
      old.prepare(
        `INSERT INTO users (login, display_name, pass_hash, pass_salt, pass_params, role, disabled, created_at)
         VALUES (?, ?, zeroblob(64), zeroblob(16), 'scrypt:32768:8:1', ?, ?, 1)`,
      ).run(login, login.toUpperCase(), role, disabled);
    }
    const id = (login: string): number => people.findIndex(([name]) => name === login) + 1;
    old.prepare("INSERT INTO games (title, kind, owner_id, gm_id, created_at) VALUES ('Склеп', 'gm', ?, ?, 1)").run(id("master"), id("master"));
    const codes: [number, "register" | "game", string][] = [
      [1, "register", "admin"],
      [2, "register", "demoted"],
      [3, "game", "demoted"],
      [4, "register", "gone_admin"],
      [5, "game", "gone_admin"],
      [6, "game", "master"],
      [7, "game", "gone_master"],
      [8, "game", "admin"],
    ];
    for (const [n, kind, login] of codes) {
      old.prepare("INSERT INTO invites (code_hash, kind, game_id, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, 100, 5, 1)").run(
        new Uint8Array(32).fill(n),
        kind,
        kind === "game" ? 1 : null,
        id(login),
      );
    }
    old.close();

    const db = new Database(file);
    try {
      assert.equal(inspect().version, 3);
      // Kept: the administrator's codes, a demoted administrator's game invite, an enabled master's game invite.
      const kept = [1, 3, 6, 8];
      for (const [n] of codes) assert.equal(db.findInvite(new Uint8Array(32).fill(n)) !== undefined, kept.includes(n), `code ${n}`);
      assert.deepEqual(db.findInvite(new Uint8Array(32).fill(3)), { kind: "game", gameId: 1, createdBy: id("demoted"), creatorIsAdmin: false, expiresAt: 100, uses: 1, maxUses: 5 });
      assert.deepEqual(
        db.listActiveInvites(50).map(({ id: inviteId, creatorName }) => [inviteId, creatorName]),
        [
          [4, "ADMIN"],
          [3, "MASTER"],
          [2, "DEMOTED"],
          [1, "ADMIN"],
        ],
      );
      // AUTOINCREMENT: the id of the newest code, once deleted, is never given again.
      assert.equal(db.deleteInvite(4), true);
      db.insertInvite(new Uint8Array(32).fill(9), "register", null, id("admin"), 100, 1);
      assert.equal(db.listActiveInvites(50)[0].id, 5);
    } finally {
      db.close();
    }
    const upgraded = inspect();
    new Database(file).close();
    assert.deepEqual(inspect(), upgraded, "a second start changes nothing");
  });

  test("running the migrations again changes nothing, data included", () => {
    const first = new Database(file);
    first.insertUser({
      login: "anna",
      displayName: "Анна",
      passHash: new Uint8Array(64),
      passSalt: new Uint8Array(16),
      passParams: "scrypt:32768:8:1",
      role: "user",
      mustChangePassword: false,
      createdAt: 1,
    });
    first.close();
    const before = inspect();

    new Database(file).close();

    assert.deepEqual(inspect(), before);
    const again = new Database(file);
    try {
      assert.equal(again.findUserByLogin("anna")?.displayName, "Анна");
      assert.equal(again.countUsers(), 1);
    } finally {
      again.close();
    }
  });

  test("a failing migration leaves the database as it was", () => {
    const db = new DatabaseSync(file);
    try {
      assert.throws(() => runMigrations(db, [...MIGRATIONS, "CREATE TABLE extra (x); SELECT * FROM missing;"]));
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), MIGRATIONS.length);
      assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'extra'").get(), undefined);
    } finally {
      db.close();
    }
  });

  test("a database from a newer server is refused and not touched", () => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 99");
    db.close();
    assert.throws(() => new Database(file), /schema version 99/);
    assert.deepEqual(inspect(), { version: 99, schema: [] });
  });
});

describe("queries", () => {
  test("an invite is used at most max_uses times and not after it expires", () => {
    const db = new Database(file);
    try {
      const admin = db.insertUser({
        login: "admin",
        displayName: "A",
        passHash: new Uint8Array(64),
        passSalt: new Uint8Array(16),
        passParams: "scrypt:32768:8:1",
        role: "admin",
        mustChangePassword: false,
        createdAt: 0,
      });
      const [fresh, stale] = [1, 2].map((n) => new Uint8Array(32).fill(n));
      db.insertInvite(fresh, "register", null, admin.id, 100, 2);
      db.insertInvite(stale, "register", null, admin.id, 10, 5);
      assert.deepEqual(db.findInvite(fresh), { kind: "register", gameId: null, createdBy: admin.id, creatorIsAdmin: true, expiresAt: 100, uses: 0, maxUses: 2 });
      assert.equal(db.useInvite(fresh, "game", 50), false, "a code is used only as its own kind");
      assert.equal(db.useInvite(stale, "register", 50), false);
      assert.equal(db.useInvite(fresh, "register", 50), true);
      assert.equal(db.useInvite(fresh, "register", 50), true);
      assert.equal(db.findInvite(fresh)?.uses, 2);
      assert.equal(db.useInvite(fresh, "register", 50), false);
      db.deleteExpired(50);
      assert.equal(db.useInvite(stale, "register", 5), false, "expired invites are removed");
    } finally {
      db.close();
    }
  });

  test("an expired game invite outlives the clean-up at start, so it still reads as expired; a used-up one goes", () => {
    let db = new Database(file);
    const admin = db.insertUser({
      login: "admin",
      displayName: "A",
      passHash: new Uint8Array(64),
      passSalt: new Uint8Array(16),
      passParams: "scrypt:32768:8:1",
      role: "admin",
      mustChangePassword: false,
      createdAt: 0,
    });
    const game = db.insertGame("Игра", "gm", admin.id, admin.id, 0);
    const [expired, usedUp, register] = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
    db.insertInvite(expired, "game", game.id, admin.id, 10, 5);
    db.insertInvite(usedUp, "game", game.id, admin.id, 100, 1);
    assert.equal(db.useInvite(usedUp, "game", 5), true);
    db.insertInvite(register, "register", null, admin.id, 10, 5);
    db.close();

    // A restart: the server opens the database again and cleans up.
    db = new Database(file);
    try {
      db.deleteExpired(50);
      assert.deepEqual(db.findInvite(expired), { kind: "game", gameId: game.id, createdBy: admin.id, creatorIsAdmin: true, expiresAt: 10, uses: 0, maxUses: 5 });
      assert.equal(db.findInvite(usedUp), undefined);
      assert.equal(db.findInvite(register), undefined, "an expired registration code goes as before");
      db.deleteGameInvites(game.id);
      assert.equal(db.findInvite(expired), undefined);
    } finally {
      db.close();
    }
  });

  test("the active codes are those not expired with uses left; codes go by creator and kind, or one by id", () => {
    const db = new Database(file);
    try {
      const person = (login: string, displayName: string) =>
        db.insertUser({ login, displayName, passHash: new Uint8Array(64), passSalt: new Uint8Array(16), passParams: "test", role: "admin", mustChangePassword: false, createdAt: 0 });
      const admin = person("admin", "Анна");
      const other = person("other", "Борис");
      const game = db.insertGame("Склеп", "gm", admin.id, admin.id, 0);
      const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
      db.insertInvite(hash(1), "register", null, admin.id, 100, 2);
      db.insertInvite(hash(2), "game", game.id, admin.id, 100, 3);
      db.insertInvite(hash(3), "register", null, admin.id, 50, 1);
      db.insertInvite(hash(4), "game", game.id, admin.id, 100, 1);
      db.insertInvite(hash(5), "register", null, other.id, 100, 1);
      assert.equal(db.useInvite(hash(4), "game", 0), true);
      assert.equal(db.useInvite(hash(2), "game", 0), true);

      assert.deepEqual(db.listActiveInvites(50), [
        { id: 5, kind: "register", creatorName: "Борис", gameTitle: null, usesLeft: 1, expiresAt: 100 },
        { id: 2, kind: "game", creatorName: "Анна", gameTitle: "Склеп", usesLeft: 2, expiresAt: 100 },
        { id: 1, kind: "register", creatorName: "Анна", gameTitle: null, usesLeft: 2, expiresAt: 100 },
      ]);

      db.deleteUserInvites(admin.id, "register");
      assert.deepEqual(db.listActiveInvites(0).map(({ id }) => id), [5, 2]);
      assert.equal(db.findInvite(hash(3)), undefined, "the other registration code of the user goes too");
      db.deleteUserInvites(admin.id);
      assert.deepEqual(db.listActiveInvites(0).map(({ id }) => id), [5]);
      assert.equal(db.deleteInvite(5), true);
      assert.equal(db.deleteInvite(5), false);
      assert.deepEqual(db.listActiveInvites(0), []);
    } finally {
      db.close();
    }
  });

  test("a new password raises the version; a rehash writes only over the hash it replaces", () => {
    const db = new Database(file);
    try {
      const user = db.insertUser({
        login: "anna",
        displayName: "A",
        passHash: new Uint8Array(64).fill(1),
        passSalt: new Uint8Array(16),
        passParams: "scrypt:16384:8:1",
        role: "user",
        mustChangePassword: false,
        createdAt: 0,
      });
      assert.equal(user.passVersion, 1);
      const newer = { passHash: new Uint8Array(64).fill(2), passSalt: new Uint8Array(16), passParams: "scrypt:32768:8:1" };
      db.setPassword(user.id, newer, true);
      assert.equal(db.findUserById(user.id)?.passVersion, 2);

      const rehash = { passHash: new Uint8Array(64).fill(3), passSalt: new Uint8Array(16), passParams: "scrypt:32768:8:1" };
      db.rehashPassword(user.id, user.passHash, rehash);
      assert.deepEqual(db.findUserById(user.id)?.passHash, newer.passHash, "the reset in between is kept");
      db.rehashPassword(user.id, newer.passHash, rehash);
      const after = db.findUserById(user.id);
      assert.deepEqual(after?.passHash, rehash.passHash);
      assert.equal(after?.passVersion, 2, "a rehash keeps the version");
    } finally {
      db.close();
    }
  });

  test("deleting a user's sessions can keep the current one", () => {
    const db = new Database(file);
    try {
      const user = db.insertUser({
        login: "anna",
        displayName: "A",
        passHash: new Uint8Array(64),
        passSalt: new Uint8Array(16),
        passParams: "scrypt:32768:8:1",
        role: "user",
        mustChangePassword: false,
        createdAt: 0,
      });
      const [a, b, c] = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
      for (const hash of [a, b, c]) db.insertSession(hash, user.id, 1, 100);
      db.deleteUserSessions(user.id, b);
      assert.equal(db.findSession(a), undefined);
      assert.deepEqual(db.findSession(b), { userId: user.id, passVersion: 1, expiresAt: 100 });
      db.deleteUserSessions(user.id);
      assert.equal(db.findSession(b), undefined);
      db.insertSession(c, user.id, 1, 100);
      db.deleteExpired(100);
      assert.equal(db.findSession(c), undefined);
    } finally {
      db.close();
    }
  });
});
