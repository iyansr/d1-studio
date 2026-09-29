import { RemoteDriver } from "../../src/drivers/remote";
import { openSqlite, type SqliteConn } from "../../src/local/sqlite";
import { D1Client, type D1RawResult } from "../../src/remote/client";
import { Secret } from "../../src/remote/secret";
import { splitStatements } from "../../src/sql/split";
import { type Canned, stubFetch } from "./stub";

export const FAKE_TOKEN = "fake-d1-token-7c1e0b";
export const FAKE_TARGET = { accountId: "acc-fake", databaseId: "db-fake" };

/**
 * The D1 `raw` endpoint over a local SQLite file, so RemoteDriver can run the
 * same suites as LocalDriver. Response shapes follow `docs/notes/d1-rest.md`.
 */
export async function fakeD1(file: string, options: { readOnly?: boolean } = {}) {
  const conn = await openSqlite(file, { readOnly: false });
  const stub = stubFetch((req): Canned => {
    if (req.method !== "POST" || !req.url.pathname.endsWith("/raw")) {
      return {
        status: 404,
        body: { success: false, errors: [{ code: 7404, message: "Not found" }] },
      };
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
      return { status: 200, body: { success: true, errors: [], messages: [], result } };
    } catch (err) {
      const message = `${err instanceof Error ? err.message : String(err)}: SQLITE_ERROR`;
      return {
        status: 400,
        body: { success: false, errors: [{ code: 7500, message }], result: [] },
      };
    }
  });
  const client = new D1Client({ token: new Secret(FAKE_TOKEN), fetch: stub.fetch });
  const driver = new RemoteDriver(client, FAKE_TARGET, options.readOnly ?? false);
  return { driver, requests: stub.requests, close: () => conn.close() };
}

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
