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
  invites: ["code_hash", "kind", "game_id", "created_by", "expires_at", "max_uses", "uses"],
};

describe("migrations", () => {
  test("a version 0 database reaches version 1 with the tables of plan 6.5", () => {
    new DatabaseSync(file).close();
    assert.equal(inspect().version, 0);

    new Database(file).close();

    assert.equal(inspect().version, 1);
    assert.equal(MIGRATIONS.length, 1);
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
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 1);
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
      assert.equal(db.hasInvite(fresh, "register", 50), true);
      assert.equal(db.hasInvite(fresh, "game", 50), false);
      assert.equal(db.useInvite(stale, "register", 50), false);
      assert.equal(db.useInvite(fresh, "register", 50), true);
      assert.equal(db.useInvite(fresh, "register", 50), true);
      assert.equal(db.hasInvite(fresh, "register", 50), false);
      assert.equal(db.useInvite(fresh, "register", 50), false);
      db.deleteExpired(50);
      assert.equal(db.useInvite(stale, "register", 5), false, "expired invites are removed");
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
