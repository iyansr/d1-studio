import { RemoteDriver } from "../../src/drivers/remote";
import { openSqlite, type SqliteConn } from "../../src/local/sqlite";
import { type Account, D1Client, type D1Database, type D1RawResult } from "../../src/remote/client";
import { Secret } from "../../src/remote/secret";
import { splitStatements } from "../../src/sql/split";
import { type Canned, type Recorded, stubFetch } from "./stub";

export const FAKE_TOKEN = "fake-d1-token-7c1e0b";
export const FAKE_TARGET = { accountId: "acc-fake", databaseId: "db-fake" };

/**
 * The D1 `raw` endpoint over a local SQLite file, so RemoteDriver can run the
 * same suites as LocalDriver. Response shapes follow `docs/notes/d1-rest.md`.
 */
export const FAKE_ACCOUNT = { id: FAKE_TARGET.accountId, name: "Fake Co" };
export const FAKE_DATABASE: D1Database = {
  uuid: FAKE_TARGET.databaseId,
  name: "fake-db",
  created_at: "2025-03-14T09:26:53.589Z",
};

const envelope = (result: unknown, extra: object = {}) => ({
  success: true,
  errors: [],
  messages: [],
  result,
  ...extra,
});
const failure = (status: number, code: number, message: string): Canned => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

export interface FakeOptions {
  readOnly?: boolean;
  accounts?: Account[];
  /** Listed by the account; only `FAKE_DATABASE` can be queried. */
  databases?: D1Database[];
  /** Answers a request instead of the fake, e.g. a 429. Return nothing to pass it on. */
  intercept?: (req: Recorded) => Canned | undefined;
}

/**
 * The D1 REST API over a local SQLite file, so RemoteDriver can run the same
 * suites as LocalDriver. Shapes follow `docs/notes/d1-rest.md`. Requests
 * without `Bearer FAKE_TOKEN` get a 401.
 */
export async function fakeD1(file: string, options: FakeOptions = {}) {
  const conn = await openSqlite(file, { readOnly: false });
  const accounts = options.accounts ?? [FAKE_ACCOUNT];
  const databases = options.databases ?? [FAKE_DATABASE];
  const stub = stubFetch((req): Canned => {
    const intercepted = options.intercept?.(req);
    if (intercepted) return intercepted;
    if (req.headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`) {
      return failure(401, 10001, "Unable to authenticate request");
    }
    const parts = req.url.pathname
      .replace(/^\/client\/v4\//, "")
      .split("/")
      .map(decodeURIComponent);
    if (req.method === "GET" && parts.length === 1 && parts[0] === "accounts") {
      return { status: 200, body: envelope(accounts, { result_info: page(accounts.length) }) };
    }
    const [, account, d1, database, id, raw] = parts;
    if (account !== FAKE_TARGET.accountId || d1 !== "d1" || database !== "database") {
      return failure(404, 7404, "Not found");
    }
    if (req.method === "GET" && id === undefined) {
      return { status: 200, body: envelope(databases, { result_info: page(databases.length) }) };
    }
    const db = databases.find((d) => d.uuid === id);
    if (!db) return failure(404, 7404, "The database could not be found");
    if (req.method === "GET" && raw === undefined) return { status: 200, body: envelope(db) };
    if (req.method !== "POST" || raw !== "raw" || id !== FAKE_TARGET.databaseId) {
      return failure(404, 7404, "Not found");
    }

    const body = req.body as {
      sql?: string;
      params?: unknown[];
      batch?: { sql: string; params?: unknown[] }[];
    };
    try {
      const result = body.batch
        ? runBatch(conn, body.batch)
        : runSql(conn, body.sql ?? "", body.params);
      return { status: 200, body: envelope(result) };
    } catch (err) {
      const message = `${err instanceof Error ? err.message : String(err)}: SQLITE_ERROR`;
      return failure(400, 7500, message);
    }
  });
  const client = new D1Client({ token: new Secret(FAKE_TOKEN), fetch: stub.fetch });
  const driver = new RemoteDriver(client, FAKE_TARGET, options.readOnly ?? false);
  return { driver, fetch: stub.fetch, requests: stub.requests, close: () => conn.close() };
}

const page = (n: number) => ({ page: 1, per_page: 100, count: n, total_count: n });

function runSql(conn: SqliteConn, sql: string, params: unknown[] = []): D1RawResult[] {
  return splitStatements(sql).map((s, i) => execute(conn, s.sql, i === 0 ? params : []));
}

function runBatch(conn: SqliteConn, batch: { sql: string; params?: unknown[] }[]): D1RawResult[] {
  conn.exec("BEGIN");
  try {
    const results = batch.map((s) => execute(conn, s.sql, s.params ?? []));
    conn.exec("COMMIT");
    return results;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

function execute(conn: SqliteConn, sql: string, params: unknown[]): D1RawResult {
  const started = performance.now();
  const stmt = conn.prepare(sql);
  if (stmt.columns.length > 0) {
    const rows = stmt.all(params).map((row) => row.map(toJson));
    return {
      success: true,
      meta: meta(started, { rows_read: rows.length }),
      results: { columns: stmt.columns, rows },
    };
  }
  const { changes, lastRowId } = stmt.run(params);
  return {
    success: true,
    meta: meta(started, {
      changes,
      last_row_id: Number(lastRowId),
      rows_written: changes,
    }),
    results: { columns: [], rows: [] },
  };
}

function meta(started: number, fields: Record<string, number>) {
  const duration = performance.now() - started;
  return {
    changes: 0,
    last_row_id: 0,
    rows_read: 0,
    rows_written: 0,
    duration,
    timings: { sql_duration_ms: duration },
    ...fields,
  };
}

/** What D1 sends: numbers (lossy past 2^53) and byte arrays for BLOBs. */
function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
}
