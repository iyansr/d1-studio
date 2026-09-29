// Builds the Miniflare-style state for the e2e fixture projects. Runs from
// Playwright's globalSetup, from `pnpm dev`, or by hand with
// `node --experimental-strip-types e2e/fixtures/make.ts`. Node builtins only.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = import.meta.dirname;
const D1_DIR = path.join(".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
/** `localD1FileName("3f2a9c1e-…")`, verified against Wrangler 4.142 (plans README). */
const DB_FILE = "b42e24f17a18ea78782455811d8b104d1e7619471c8f59f3caf22389b6ce70f3.sqlite";
export const BIG_ROWS = 100_000;
export const USER_ROWS = 240;

const APP_SQL = `
  CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
  CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
  INSERT INTO d1_migrations (name) VALUES ('0001_init.sql');

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    prefs TEXT DEFAULT '{}',
    bio TEXT,
    score REAL,
    created_at INTEGER NOT NULL
  );
  WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${USER_ROWS})
  INSERT INTO users (email, name, prefs, bio, score, created_at)
  SELECT
    'user' || i || '@example.com',
    CASE WHEN i % 7 = 0 THEN NULL ELSE 'User ' || i END,
    json_object('theme', CASE WHEN i % 2 THEN 'dark' ELSE 'light' END, 'beta', json(CASE WHEN i % 3 = 0 THEN 'true' ELSE 'false' END), 'tags', json_array('a', 'b')),
    CASE WHEN i % 5 = 0 THEN 'A long biography. ' || replace(hex(zeroblob(40)), '00', 'Lorem ipsum dolor sit amet. ') ELSE NULL END,
    round(i * 1.5, 2),
    1727500000 + i * 3600
  FROM s;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX sessions_user ON sessions (user_id);
  CREATE INDEX sessions_live ON sessions (expires_at DESC) WHERE expires_at IS NOT NULL;
  WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 60)
  INSERT INTO sessions SELECT 's' || i, (i % 20) + 1, 1727500000 + i, CASE WHEN i % 4 THEN 1727600000 + i ELSE NULL END FROM s;

  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    data BLOB,
    checksum INTEGER
  );
  INSERT INTO files (name, data, checksum) VALUES
    ('logo.png', randomblob(2458), 9007199254740993),
    ('empty.txt', x'', -9007199254740993),
    ('missing.bin', NULL, 42);

  CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT NOT NULL, n REAL, flag INTEGER);
  WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${BIG_ROWS})
  INSERT INTO big SELECT i, 'row ' || i, i * 0.25, i % 2 FROM s;

  CREATE VIEW active_sessions AS
    SELECT s.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.expires_at IS NOT NULL;
`;

function createDb(file: string, sql: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(sql);
  db.close();
}

function reset(project: string): string {
  const dir = path.join(here, project, D1_DIR);
  rmSync(path.join(here, project, ".wrangler"), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeE2eFixtures() {
  const app = reset("project");
  createDb(path.join(app, DB_FILE), APP_SQL);
  createDb(path.join(app, "metadata.sqlite"), "CREATE TABLE _mf_entries (id TEXT PRIMARY KEY)");

  // Two files whose names match no binding: the studio shows the picker.
  const unmatched = reset("unmatched");
  createDb(
    path.join(unmatched, `${"a".repeat(64)}.sqlite`),
    "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); INSERT INTO users (email) VALUES ('a@example.com'), ('b@example.com');" +
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER);",
  );
  createDb(
    path.join(unmatched, `${"b".repeat(64)}.sqlite`),
    "CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO events (name) VALUES ('signup'), ('login'), ('login');",
  );
}

export function e2eFixturesExist(): boolean {
  return existsSync(path.join(here, "project", D1_DIR, DB_FILE));
}

if (process.argv[1] === import.meta.filename) makeE2eFixtures();

/** Small tables for the editing specs: each spec gets its own copy, since they write. */
const EDIT_SQL = `
  CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    age INTEGER,
    score REAL,
    prefs TEXT DEFAULT '{}',
    bio TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 12)
  INSERT INTO users (email, name, age, score, prefs, bio)
  SELECT 'user' || i || '@example.com', 'User ' || i, 20 + i, i * 1.5,
    CASE WHEN i = 1 THEN '{"theme":"dark","tags":["a","b"]}' ELSE '{}' END,
    CASE WHEN i = 2 THEN 'first line' || char(10) || 'second line' ELSE NULL END
  FROM s;

  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'untitled',
    body TEXT DEFAULT 'todo',
    pinned INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO notes (title, body) VALUES ('first', 'hello'), ('second', 'world');

  CREATE TABLE memberships (org INTEGER NOT NULL, usr INTEGER NOT NULL, role TEXT, PRIMARY KEY (usr, org)) WITHOUT ROWID;
  INSERT INTO memberships VALUES (1, 1, 'owner'), (1, 2, 'member'), (2, 1, 'member');

  CREATE TABLE files (id INTEGER PRIMARY KEY, name TEXT, data BLOB);
  INSERT INTO files (name, data) VALUES ('logo.png', randomblob(64));

  CREATE VIEW user_emails AS SELECT id, email FROM users;
`;

/** Writes `EDIT_SQL` into a fresh database file. */
export function makeEditDb(file: string) {
  rmSync(file, { force: true });
  createDb(file, EDIT_SQL);
}

/** A throwaway Wrangler project with the editing tables, for one spec. Returns its directory. */
export function makeEditProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "d1s-e2e-edit-"));
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "e2e-edit",
      main: "src/index.ts",
      compatibility_date: "2026-09-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "app-db",
          database_id: "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90",
        },
      ],
    }),
  );
  const d1 = path.join(dir, D1_DIR);
  mkdirSync(d1, { recursive: true });
  makeEditDb(path.join(d1, DB_FILE));
  return dir;
}
