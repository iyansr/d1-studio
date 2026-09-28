// Builds the Miniflare-style state for fixture projects. Runs from vitest's
// globalSetup, or by hand with `pnpm fixtures`. Imports only node builtins so
// Node can run it with type stripping.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = import.meta.dirname;

/** The two derivations verified against Wrangler 4.142 (plans README). */
export const DB_FILE = "b42e24f17a18ea78782455811d8b104d1e7619471c8f59f3caf22389b6ce70f3.sqlite";
export const ANALYTICS_FILE =
  "3e305aef760bad9b39bcf49d44331af5df47ee3654b1a3aa8af292b897809d07.sqlite";

const D1_BOOKKEEPING = `
  CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
  CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

const DB_SQL = `
  ${D1_BOOKKEEPING}
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  INSERT INTO users (email, name) VALUES ('ada@example.com', 'Ada'), ('alan@example.com', 'Alan');
  INSERT INTO sessions VALUES ('s1', 1, 1727500000), ('s2', 1, 1727500100), ('s3', 2, 1727500200);
`;

const ANALYTICS_SQL = `
  ${D1_BOOKKEEPING}
  CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL);
  INSERT INTO events (name, at) VALUES ('signup', 1), ('login', 2), ('login', 3), ('logout', 4);
`;

function createDb(file: string, sql: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(sql);
  db.close();
}

export function makeFixtures() {
  const state = path.join(here, "project-two-dbs", ".wrangler", "state");
  const d1 = path.join(state, "v3", "d1", "miniflare-D1DatabaseObject");
  rmSync(state, { recursive: true, force: true });
  mkdirSync(d1, { recursive: true });
  createDb(path.join(d1, DB_FILE), DB_SQL);
  createDb(path.join(d1, ANALYTICS_FILE), ANALYTICS_SQL);
  createDb(path.join(d1, "metadata.sqlite"), "CREATE TABLE _mf_entries (id TEXT PRIMARY KEY)");
}

if (process.argv[1] === import.meta.filename) makeFixtures();
