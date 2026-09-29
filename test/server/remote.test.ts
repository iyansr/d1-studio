import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { LocalDriver } from "../../src/drivers/local";
import { RemoteDriver } from "../../src/drivers/remote";
import type { Driver } from "../../src/drivers/types";
import { d1StateDir } from "../../src/local/locate";
import { D1Client } from "../../src/remote/client";
import { Secret } from "../../src/remote/secret";
import { createApp } from "../../src/server/app";
import { type AppContext, readySession } from "../../src/server/context";
import { DB_FILE } from "../fixtures/make";
import { fakeD1 } from "../remote/fake-d1";
import { type Canned, fixture, sequence } from "../remote/stub";

const TOKEN = "session-token";
const PORT = 4101;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const tmp = mkdtempSync(path.join(tmpdir(), "d1s-remote-app-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const fixtureDb = path.join(
  d1StateDir(path.resolve(import.meta.dirname, "../fixtures/project-two-dbs/.wrangler/state")),
  DB_FILE,
);

function copyDb(): string {
  const file = path.join(tmp, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  copyFileSync(fixtureDb, file);
  return file;
}

function app(driver: Driver) {
  const ctx: AppContext = {
    version: "1.2.3",
    mode: driver.mode,
    readOnly: driver.readOnly,
    token: TOKEN,
    bind: { host: "127.0.0.1", port: PORT },
    uiDir: tmp,
    session: readySession(driver, { name: "prod-db", binding: "DB", id: "3f2a" }),
    notices: [],
    logError: () => {},
  };
  const a = createApp(ctx);
  const headers = { Cookie: `d1s_${PORT}=${TOKEN}` };
  return {
    get: (url: string) => a.request(`${ORIGIN}${url}`, { headers }),
    query: (sql: string) =>
      a.request(`${ORIGIN}/api/query`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ sql }),
      }),
  };
}

/** 1,500 rows. */
const SEED_BIG =
  "CREATE TABLE big (n INTEGER); " +
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1500) " +
  "INSERT INTO big SELECT x FROM c";

const WRITES = [
  "INSERT INTO users (email) VALUES ('x@y.z')",
  "UPDATE users SET email = 'x'",
  "DELETE FROM users",
  "/**/DELETE FROM users",
  "WITH x AS (SELECT 1) DELETE FROM users",
  "SELECT 1; DELETE FROM users",
  "REPLACE INTO users (id, email) VALUES (1, 'x')",
  "CREATE TABLE evil (a)",
  "DROP TABLE users",
  "ALTER TABLE users ADD COLUMN evil",
  "CREATE INDEX evil ON users (email)",
  "pragma writable_schema=1",
  "PRAGMA user_version = 7",
  "ATTACH 'evil.db' AS evil",
  "VACUUM",
  "REINDEX",
  "BEGIN",
];

describe.each([
  [
    "local --no-write",
    async () => ({ driver: await LocalDriver.open(copyDb(), { readOnly: true }) }),
  ],
  ["remote", async () => fakeD1(copyDb(), { readOnly: true })],
])("read-only (%s)", (_, open) => {
  let driver: Driver;
  let requests: unknown[] | undefined;
  beforeEach(async () => {
    const opened = await open();
    driver = opened.driver;
    requests = "requests" in opened ? opened.requests : undefined;
    return () => {
      if ("close" in opened) opened.close();
      return driver.close();
    };
  });

  test.each(WRITES)("403 for %j, and nothing reaches the database", async (sql) => {
    const snapshot = async () =>
      (await driver.query("SELECT count(*) FROM users; PRAGMA user_version")).map((r) => r.rows);
    const before = await snapshot();
    const sent = requests?.length ?? 0;
    const res = await app(driver).query(sql);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(
      /^Read-only mode: \S+ is not allowed\. Restart with --write/,
    );
    expect(requests?.length ?? 0).toBe(sent);
    expect(await snapshot()).toEqual(before);
  });

  test("reads still work", async () => {
    const res = await app(driver).query("SELECT count(*) AS n FROM users; PRAGMA table_list");
    expect(res.status).toBe(200);
  });
});

describe("remote", () => {
  let remote: Awaited<ReturnType<typeof fakeD1>>;
  beforeEach(async () => {
    remote = await fakeD1(copyDb(), { readOnly: false });
    await remote.driver.query(SEED_BIG);
    return () => remote.close();
  });

  test("an unbounded editor SELECT is limited to 1,000 rows with a notice", async () => {
    const res = await app(remote.driver).query("SELECT * FROM big;");
    const body = (await res.json()) as {
      results: { rows: unknown[]; rowsRead: number }[];
      notice?: unknown;
      elapsedMs: number;
    };
    expect(res.status).toBe(200);
    expect(body.results[0]?.rows).toHaveLength(1000);
    expect(body.notice).toEqual({ kind: "auto-limit", limit: 1000 });
    expect(typeof body.elapsedMs).toBe("number");
    expect(remote.requests.at(-1)?.body).toEqual({ sql: "SELECT * FROM big LIMIT 1001" });
  });

  test("the user's own LIMIT, or fewer rows, get no notice", async () => {
    const own = await (await app(remote.driver).query("SELECT * FROM big LIMIT 1200")).json();
    expect(own).toMatchObject({ results: [{ rows: expect.any(Array) }] });
    expect((own as { results: { rows: unknown[] }[] }).results[0]?.rows).toHaveLength(1200);
    expect(own).not.toHaveProperty("notice");

    const few = await (await app(remote.driver).query("SELECT * FROM big WHERE n <= 10")).json();
    expect((few as { results: { rows: unknown[] }[] }).results[0]?.rows).toHaveLength(10);
    expect(few).not.toHaveProperty("notice");
  });

  test("local mode never adds a LIMIT", async () => {
    const local = await LocalDriver.open(copyDb(), { readOnly: false });
    try {
      await local.query(SEED_BIG);
      const body = (await (await app(local).query("SELECT * FROM big")).json()) as {
        results: { rows: unknown[] }[];
      };
      expect(body.results[0]?.rows).toHaveLength(1500);
      expect(body).not.toHaveProperty("notice");
    } finally {
      await local.close();
    }
  });

  test("tables come without counts; counts are lazy, cached and refreshable", async () => {
    const a = app(remote.driver);
    const tables = (await (await a.get("/api/tables")).json()) as {
      tables: { name: string; rows: number | null }[];
    };
    expect(tables.tables.find((t) => t.name === "big")?.rows).toBeNull();
    expect(tables.tables.every((t) => t.rows === null)).toBe(true);

    const first = await a.get("/api/tables/counts");
    const body = (await first.json()) as {
      counts: Record<string, number | null>;
      rowsRead: number;
    };
    expect(body.counts.big).toBe(1500);
    expect(body.counts).not.toHaveProperty("_cf_KV");
    expect(body.rowsRead).toBeGreaterThan(0);

    const sent = remote.requests.length;
    await a.get("/api/tables/counts");
    expect(remote.requests.length).toBe(sent);
    await remote.driver.query("DELETE FROM big WHERE n > 100");
    const refreshed = (await (await a.get("/api/tables/counts?refresh=1")).json()) as {
      counts: Record<string, number>;
    };
    expect(refreshed.counts.big).toBe(100);
  });

  test("usage totals rows read and written", async () => {
    const a = app(remote.driver);
    await a.query("SELECT * FROM big WHERE n <= 5");
    const { usage } = (await (await a.get("/api/usage")).json()) as {
      usage: { rowsRead: number; rowsWritten: number };
    };
    expect(usage.rowsRead).toBeGreaterThanOrEqual(5);
    expect(usage.rowsWritten).toBeGreaterThanOrEqual(1500);
  });
});

describe("D1 API errors", () => {
  const driverFor = (...responses: Canned[]) =>
    new RemoteDriver(
      new D1Client({
        token: new Secret("t"),
        fetch: sequence(...responses).fetch,
        sleep: async () => {},
      }),
      { accountId: "a", databaseId: "d" },
      true,
    );

  test("a SQL error is a 400 with D1's message", async () => {
    const res = await app(driverFor(fixture("error-sql"))).query("SELECT * FROM nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: "no such table: nope: SQLITE_ERROR" } });
  });

  test("a rate limit is a 429 with Retry-After", async () => {
    const long: Canned = { ...fixture("error-rate-limit"), headers: { "Retry-After": "42" } };
    const res = await app(driverFor(long)).query("SELECT 1");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toEqual({
      error: {
        message: "Please wait and consider throttling your request speed",
        retryAfter: 42,
      },
    });
  });

  test("an upstream 401 is a 502, never a 401 (the UI reads 401 as a lost session)", async () => {
    const res = await app(driverFor(fixture("error-unauthenticated"))).get("/api/tables");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: "Unable to authenticate request" } });
  });

  test("usage is null in local mode", async () => {
    const local = await LocalDriver.open(copyDb(), { readOnly: true });
    try {
      expect(await (await app(local).get("/api/usage")).json()).toEqual({ usage: null });
    } finally {
      await local.close();
    }
  });
});
