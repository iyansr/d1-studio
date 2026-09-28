import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { LocalDriver } from "../../src/drivers/local";
import type { Driver } from "../../src/drivers/types";
import { d1StateDir, listCandidates } from "../../src/local/locate";
import { createApp } from "../../src/server/app";
import { type AppContext, readySession } from "../../src/server/context";
import { allowedHosts, isLoopback } from "../../src/server/security";
import { DB_FILE } from "../fixtures/make";

const TOKEN = "test-token-abc";
const PORT = 4101;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `d1s_${PORT}=${TOKEN}`;

const tmp = mkdtempSync(path.join(tmpdir(), "d1s-app-"));
const uiDir = path.join(tmp, "ui");
const fixtureDir = d1StateDir(
  path.resolve(import.meta.dirname, "../fixtures/project-two-dbs/.wrangler/state"),
);
let dbFile: string;
let driver: LocalDriver;

beforeAll(() => {
  mkdirSync(path.join(uiDir, "assets"), { recursive: true });
  writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>studio</title>");
  writeFileSync(path.join(uiDir, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(path.join(tmp, "secret.txt"), "secret");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  dbFile = path.join(tmp, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  copyFileSync(path.join(fixtureDir, DB_FILE), dbFile);
  driver = await LocalDriver.open(dbFile, { readOnly: false });
  return () => driver.close();
});

const database = { name: "app-db", binding: "DB", id: "3f2a9c1e" };
function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    version: "1.2.3",
    mode: "local",
    readOnly: false,
    token: TOKEN,
    bind: { host: "127.0.0.1", port: PORT },
    uiDir,
    session: readySession(driver, database),
    logError: () => {},
    ...overrides,
  };
}

type Init = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
const request = (app: ReturnType<typeof createApp>, url: string, init: Init = {}) =>
  app.request(`http://127.0.0.1:${PORT}${url}`, init);
const authed = (init: Init = {}): Init => ({
  ...init,
  headers: { Cookie: COOKIE, ...init.headers },
});
const post = (body: unknown, headers: Record<string, string> = {}): Init =>
  authed({
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

describe("auth", () => {
  test("no cookie gives 401 JSON on the API and a hint page on HTML routes", async () => {
    const app = createApp(makeCtx());
    const api = await request(app, "/api/tables");
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({
      error: { message: "Unauthorized. Open the link printed in your terminal." },
    });
    const html = await request(app, "/");
    expect(html.status).toBe(401);
    expect(await html.text()).toContain("Open the link printed in your terminal");
  });

  test("a bad ?t= gives 401", async () => {
    const res = await request(createApp(makeCtx()), "/?t=wrong");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a wrong cookie gives 401", async () => {
    const res = await request(createApp(makeCtx()), "/api/meta", {
      headers: { Cookie: `d1s_${PORT}=nope` },
    });
    expect(res.status).toBe(401);
  });

  test("a cookie for another port doesn't count", async () => {
    const res = await request(createApp(makeCtx()), "/api/meta", {
      headers: { Cookie: `d1s_4102=${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  test("a good ?t= sets the cookie and redirects without the token", async () => {
    const res = await request(createApp(makeCtx()), `/tables/users?t=${TOKEN}&x=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/tables/users?x=1");
    expect(res.headers.get("set-cookie")).toBe(`${COOKIE}; HttpOnly; SameSite=Strict; Path=/`);
  });

  test("the cookie grants access", async () => {
    const res = await request(createApp(makeCtx()), "/api/meta", authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "1.2.3",
      mode: "local",
      database,
      readOnly: false,
      state: "ready",
    });
  });
});

describe("host and origin", () => {
  test("a foreign Host gets 403 even with a valid cookie", async () => {
    const res = await request(
      createApp(makeCtx()),
      "/api/tables",
      authed({ headers: { Host: "evil.test" } }),
    );
    expect(res.status).toBe(403);
  });

  test.each([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`])(
    "Host %s is allowed",
    async (host) => {
      const res = await request(
        createApp(makeCtx()),
        "/api/meta",
        authed({ headers: { Host: host } }),
      );
      expect(res.status).toBe(200);
    },
  );

  test("the right host on the wrong port gets 403", async () => {
    const res = await request(
      createApp(makeCtx()),
      "/api/meta",
      authed({ headers: { Host: "127.0.0.1:9999" } }),
    );
    expect(res.status).toBe(403);
  });

  test("the --host value is allowed", async () => {
    const app = createApp(makeCtx({ bind: { host: "192.168.1.20", port: PORT } }));
    const res = await request(
      app,
      "/api/meta",
      authed({ headers: { Host: `192.168.1.20:${PORT}` } }),
    );
    expect(res.status).toBe(200);
  });

  test("a cross-origin POST gets 403", async () => {
    const res = await request(
      createApp(makeCtx()),
      "/api/query",
      post({ sql: "SELECT 1" }, { Origin: "http://evil.test" }),
    );
    expect(res.status).toBe(403);
  });

  test("a POST without Origin gets 403", async () => {
    const init = post({ sql: "SELECT 1" });
    delete init.headers?.Origin;
    const res = await request(createApp(makeCtx()), "/api/query", init);
    expect(res.status).toBe(403);
  });

  test("a GET with a foreign Origin gets 403", async () => {
    const res = await request(
      createApp(makeCtx()),
      "/api/tables",
      authed({ headers: { Origin: "http://evil.test" } }),
    );
    expect(res.status).toBe(403);
  });

  test("a same-origin POST is allowed", async () => {
    const res = await request(createApp(makeCtx()), "/api/query", post({ sql: "SELECT 1" }));
    expect(res.status).toBe(200);
  });

  test("allowedHosts covers interfaces for a wildcard bind", () => {
    const hosts = allowedHosts("0.0.0.0", 5000);
    expect(hosts.has("127.0.0.1:5000")).toBe(true);
    expect(hosts.has("0.0.0.0:5000")).toBe(false);
  });

  test("isLoopback", () => {
    expect(["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "192.168.1.2", "::", "example.com"].some(isLoopback)).toBe(false);
  });
});

describe("headers", () => {
  test("security headers on API, HTML and error responses", async () => {
    const app = createApp(makeCtx());
    for (const res of [
      await request(app, "/api/meta", authed()),
      await request(app, "/", authed()),
      await request(app, "/api/meta"),
      await request(app, "/api/meta", { headers: { Host: "evil.test" } }),
    ]) {
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      );
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await request(app, "/api/meta", authed())).headers.get("cache-control")).toBe(
      "no-store",
    );
  });
});

describe("routes", () => {
  test("GET /api/tables lists tables with counts", async () => {
    const res = await request(createApp(makeCtx()), "/api/tables", authed());
    expect(res.status).toBe(200);
    const { tables } = (await res.json()) as {
      tables: { name: string; hidden: boolean; rows: number | null }[];
    };
    expect(tables.filter((t) => !t.hidden).map((t) => [t.name, t.rows])).toEqual([
      ["sessions", 3],
      ["users", 2],
    ]);
    expect(tables.find((t) => t.name === "_cf_KV")).toMatchObject({ hidden: true, rows: null });
  });

  test("GET /api/tables/:name/schema", async () => {
    const app = createApp(makeCtx());
    const res = await request(app, "/api/tables/sessions/schema", authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "sessions",
      primaryKey: ["id"],
      foreignKeys: [{ table: "users" }],
    });
    const missing = await request(app, "/api/tables/nope/schema", authed());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { message: "No such table: nope" } });
  });

  test("POST /api/query returns one result per statement", async () => {
    const res = await request(
      createApp(makeCtx()),
      "/api/query",
      post({ sql: "SELECT ? AS a; SELECT 2 AS a", params: [] }),
    );
    expect(await res.json()).toMatchObject({
      results: [
        { columns: ["a"], rows: [[null]] },
        { columns: ["a"], rows: [[2]] },
      ],
    });
  });

  test("a driver error becomes a 400 with the verbatim message, and the server keeps serving", async () => {
    const app = createApp(makeCtx());
    const res = await request(app, "/api/query", post({ sql: "SELECT 1; SELECT * FROM nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: "no such table: nope", statementIndex: 1 },
    });
    expect((await request(app, "/api/query", post({ sql: "SELECT 1" }))).status).toBe(200);
  });

  test("an unexpected error becomes a generic 500 and is logged locally", async () => {
    const logError = vi.fn();
    const broken: Driver = {
      mode: "local",
      readOnly: false,
      query: () => Promise.reject(new Error("secret internals")),
      batch: () => Promise.reject(new Error("x")),
      close: async () => {},
    };
    const app = createApp(makeCtx({ session: readySession(broken, database), logError }));
    const res = await request(app, "/api/tables", authed());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: "Internal server error" } });
    expect(logError).toHaveBeenCalledOnce();
  });

  test.each([
    [{}, '"sql" must be a string.'],
    [{ sql: 1 }, '"sql" must be a string.'],
    [
      { sql: "SELECT ?", params: [{}] },
      '"params" must be an array of null, number, string or boolean values.',
    ],
  ])("bad body %j gives 400", async (body, message) => {
    const res = await request(createApp(makeCtx()), "/api/query", post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message } });
  });

  test("malformed JSON gives 400", async () => {
    const init = post({});
    init.body = "{nope";
    const res = await request(createApp(makeCtx()), "/api/query", init);
    expect(res.status).toBe(400);
  });

  test("DDL through /api/query invalidates the schema cache", async () => {
    const app = createApp(makeCtx());
    await request(app, "/api/tables", authed());
    await request(app, "/api/query", post({ sql: "CREATE TABLE fresh (x)" }));
    const { tables } = (await (await request(app, "/api/tables", authed())).json()) as {
      tables: { name: string }[];
    };
    expect(tables.map((t) => t.name)).toContain("fresh");
  });

  test("unknown API routes 404 as JSON", async () => {
    const res = await request(createApp(makeCtx()), "/api/nope", authed());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: "Not found" } });
  });
});

describe("needs-db state", () => {
  test("lists candidates without paths, then opens one", async () => {
    const candidates = await listCandidates(fixtureDir);
    const opened: string[] = [];
    const ctx = makeCtx({
      session: { state: "needs-db", candidates },
      openCandidate: async (c) => {
        opened.push(c.path);
        return { driver, database: { name: c.fileName, binding: null, id: null } };
      },
    });
    const app = createApp(ctx);

    expect(await (await request(app, "/api/meta", authed())).json()).toMatchObject({
      state: "needs-db",
      database: null,
    });
    expect((await request(app, "/api/tables", authed())).status).toBe(409);

    const list = (await (await request(app, "/api/candidates", authed())).json()) as {
      candidates: Record<string, unknown>[];
    };
    expect(list.candidates).toHaveLength(2);
    for (const c of list.candidates) {
      expect(c).not.toHaveProperty("path");
      expect(JSON.stringify(c)).not.toContain(fixtureDir);
    }

    expect((await request(app, "/api/open", post({ candidateId: 99 }))).status).toBe(404);
    expect((await request(app, "/api/open", post({ candidateId: "../x" }))).status).toBe(400);
    const target = candidates.find((c) => c.fileName === DB_FILE);
    const res = await request(app, "/api/open", post({ candidateId: target?.id }));
    expect(res.status).toBe(200);
    expect(opened).toEqual([target?.path]);
    expect(ctx.session.state).toBe("ready");
    expect((await request(app, "/api/tables", authed())).status).toBe(200);
    expect((await request(app, "/api/open", post({ candidateId: 0 }))).status).toBe(409);
  });
});

describe("static", () => {
  test("serves index.html with SPA fallback", async () => {
    const app = createApp(makeCtx());
    for (const url of ["/", "/tables/users"]) {
      const res = await request(app, url, authed());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>studio</title>");
    }
  });

  test("hashed assets are immutable", async () => {
    const res = await request(createApp(makeCtx()), "/assets/app-abc123.js", authed());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("missing files 404 and traversal is blocked", async () => {
    const app = createApp(makeCtx());
    expect((await request(app, "/assets/missing.js", authed())).status).toBe(404);
    for (const url of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
    ]) {
      const res = await request(app, url, authed());
      expect(await res.text()).not.toBe("secret");
    }
  });
});
