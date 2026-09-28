// Builds the Miniflare-style state for the e2e fixture projects. Runs from
// Playwright's globalSetup, from `pnpm dev`, or by hand with
// `node --experimental-strip-types e2e/fixtures/make.ts`. Node builtins only.
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
