import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listTables, SchemaCache } from "../../src/drivers/introspect";
import { RemoteDriver } from "../../src/drivers/remote";
import { API_BASE, D1Client } from "../../src/remote/client";
import { Secret } from "../../src/remote/secret";
import { createApp } from "../../src/server/app";
import { type AppContext, readySession } from "../../src/server/context";

/**
 * Optional live suite against a real, throwaway D1 database (T10). Runs only
 * with D1S_LIVE_TOKEN (D1 Edit) and D1S_LIVE_ACCOUNT set. Never point it at
 * an account with production data you care about: it creates and deletes a
 * database named `d1s-live-<timestamp>`.
 */
const token = process.env.D1S_LIVE_TOKEN;
const accountId = process.env.D1S_LIVE_ACCOUNT;
const live = Boolean(token && accountId);

const PORT = 4101;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Create and delete aren't part of the studio's client: tests only. */
async function admin(method: "POST" | "DELETE", path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}/accounts/${accountId}/d1/database${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as {
    success: boolean;
    result: { uuid: string };
    errors: unknown;
  };
  if (!json.success) throw new Error(`${method} ${path} failed: ${JSON.stringify(json.errors)}`);
  return json.result;
}

describe.skipIf(!live)("live D1", () => {
  let databaseId: string;
  let writer: RemoteDriver;
  let reader: RemoteDriver;

  beforeAll(async () => {
    ({ uuid: databaseId } = await admin("POST", "", { name: `d1s-live-${Date.now()}` }));
    const client = new D1Client({ token: new Secret(token as string) });
    const target = { accountId: accountId as string, databaseId };
    writer = new RemoteDriver(client, target, false);
    reader = new RemoteDriver(client, target, true);
    await writer.query(
      "CREATE TABLE big (n INTEGER PRIMARY KEY, label TEXT, data BLOB);" +
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1500) " +
        "INSERT INTO big (n, label) SELECT x, 'row ' || x FROM c;" +
        "UPDATE big SET data = x'00ff10' WHERE n = 1;" +
        "CREATE TABLE child (id INTEGER PRIMARY KEY, big_n INTEGER REFERENCES big (n));" +
        "CREATE INDEX child_big ON child (big_n);",
    );
  }, 60_000);

  afterAll(async () => {
    if (databaseId) await admin("DELETE", `/${databaseId}`);
  }, 60_000);

  function app(driver: RemoteDriver) {
    const ctx: AppContext = {
      version: "live",
      mode: "remote",
      readOnly: driver.readOnly,
      token: "t",
      bind: { host: "127.0.0.1", port: PORT },
      uiDir: ".",
      session: readySession(driver, { name: "live", binding: null, id: databaseId }),
      notices: [],
    };
    const a = createApp(ctx);
    return (sql: string) =>
      a.request(`${ORIGIN}/api/query`, {
        method: "POST",
        headers: { Cookie: `d1s_${PORT}=t`, Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
  }

  /** POSTs JSON to the studio app over the live driver, as the UI would. */
  function post(driver: RemoteDriver, path: string, body: unknown) {
    const ctx: AppContext = {
      version: "live",
      mode: "remote",
      readOnly: driver.readOnly,
      token: "t",
      bind: { host: "127.0.0.1", port: PORT },
      uiDir: ".",
      session: readySession(driver, { name: "live", binding: null, id: databaseId }),
      notices: [],
    };
    return createApp(ctx).request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { Cookie: `d1s_${PORT}=t`, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("read", () => {
    test("rows, BLOBs and D1 meta", async () => {
      const [result] = await reader.query("SELECT n, label, data FROM big WHERE n = 1");
      expect(result?.rows).toEqual([[1, "row 1", { $blob: 3 }]]);
      expect(result?.rowsRead).toBeGreaterThan(0);
    });

    test("introspection (S5)", async () => {
      const tables = await listTables(reader.query.bind(reader));
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["big", "child"]));
      const schema = await new SchemaCache(reader.query.bind(reader)).describe("child");
      expect(schema.foreignKeys[0]).toMatchObject({ table: "big", from: ["big_n"] });
      expect(schema.indexes.map((i) => i.name)).toContain("child_big");
    });

    test("parameter types (S1)", async () => {
      const [result] = await reader.query("SELECT typeof(?), typeof(?), typeof(?)", [1, 1.5, null]);
      // Records how the REST API binds JSON values; see docs/notes/d1-rest.md.
      console.info("D1 REST binds [1, 1.5, null] as", result?.rows[0]);
      expect(result?.rows[0]?.[2]).toBe("null");
    });
  });

  describe("read-only", () => {
    test("writes are refused before they reach D1", async () => {
      const query = app(reader);
      for (const sql of ["DELETE FROM big", "DROP TABLE big", "PRAGMA foreign_keys = off"]) {
        expect((await query(sql)).status).toBe(403);
      }
      const [count] = await reader.query("SELECT count(*) FROM big");
      expect(count?.rows[0]?.[0]).toBe(1500);
    });
  });

  describe("auto-limit", () => {
    test("an unbounded SELECT returns 1,000 rows and a notice", async () => {
      const res = await app(reader)("SELECT n FROM big");
      const body = (await res.json()) as { results: { rows: unknown[] }[]; notice?: unknown };
      expect(body.results[0]?.rows).toHaveLength(1000);
      expect(body.notice).toEqual({ kind: "auto-limit", limit: 1000 });
    });
  });

  describe("batch (S1 atomicity)", () => {
    test("all statements commit together", async () => {
      await writer.batch([
        { sql: "INSERT INTO child (id, big_n) VALUES (?, ?)", params: [1, 1] },
        { sql: "INSERT INTO child (id, big_n) VALUES (?, ?)", params: [2, 2] },
      ]);
      const [count] = await reader.query("SELECT count(*) FROM child");
      expect(count?.rows[0]?.[0]).toBe(2);
    });

    test("a failing 2nd statement rolls back the 1st", async () => {
      await expect(
        writer.batch([
          { sql: "INSERT INTO child (id, big_n) VALUES (3, 3)" },
          { sql: "INSERT INTO nope VALUES (1)" },
        ]),
      ).rejects.toThrow();
      const [row] = await reader.query("SELECT count(*) FROM child WHERE id = 3");
      expect(row?.rows[0]?.[0]).toBe(0);
    });
  });

  describe("grid edits (plan 04)", () => {
    const row = (rowid: number) => ({ kind: "rowid", rowid }) as const;
    const childIds = async () =>
      (await reader.query("SELECT id FROM child ORDER BY id"))[0]?.rows.map((r) => r[0]);

    test("a batch without a confirmation is refused with the SQL, and runs nothing", async () => {
      const before = await childIds();
      const res = await post(writer, "/api/batch", {
        table: "child",
        ops: [{ op: "insert", values: { id: 100, big_n: 1 } }],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "confirmation_required",
      );
      expect(await childIds()).toEqual(before);
    });

    test("a batch whose 3rd op fails leaves the database unchanged (S1 atomicity)", async () => {
      const before = await childIds();
      const res = await post(writer, "/api/batch", {
        table: "child",
        confirm: true,
        ops: [
          { op: "insert", values: { id: 200, big_n: 1 } },
          { op: "insert", values: { id: 201, big_n: 1 } },
          // Primary key clash with a row that exists.
          { op: "insert", values: { id: 1, big_n: 1 } },
        ],
      });
      expect(res.status).toBe(400);
      expect(await childIds()).toEqual(before);
    });

    test("applies inserts, updates and deletes in one batch", async () => {
      const res = await post(writer, "/api/batch", {
        table: "child",
        confirm: true,
        ops: [
          { op: "insert", values: { id: 300, big_n: 5 } },
          { op: "update", key: row(1), set: { big_n: 7 } },
          { op: "delete", key: row(2) },
        ],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ inserted: 1, updated: 1, deleted: 1, warnings: [] });
      const [rows] = await reader.query(
        "SELECT id, big_n FROM child WHERE id IN (1, 2, 300) ORDER BY id",
      );
      expect(rows?.rows).toEqual([
        [1, 7],
        [300, 5],
      ]);
    });

    test("D1 can't abort on a row count, so a missing row is a warning (S1)", async () => {
      const res = await post(writer, "/api/batch", {
        table: "child",
        confirm: true,
        ops: [{ op: "update", key: row(99999), set: { big_n: 1 } }],
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { warnings: unknown[] }).warnings).toHaveLength(1);
    });

    test("64-bit integers: how the REST API binds a $int (S1)", async () => {
      const res = await post(writer, "/api/batch", {
        table: "child",
        confirm: true,
        ops: [{ op: "insert", values: { id: { $int: "9007199254740993" }, big_n: 1 } }],
      });
      expect(res.status).toBe(200);
      const [result] = await reader.query(
        "SELECT CAST(id AS TEXT), typeof(id) FROM child WHERE id > 9007199254740000",
      );
      // Records the answer for docs/notes/d1-rest.md: text is coerced by the INTEGER key, or not.
      console.info("D1 REST stored a $int key as", result?.rows[0]);
      expect(result?.rows[0]).toEqual(["9007199254740993", "integer"]);
    });
  });
});
