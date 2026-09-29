import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseCli } from "../../src/cli/args";
import { formatBanner } from "../../src/cli/banner";
import { openRemote, type RemoteDeps } from "../../src/cli/remote";
import { createApp } from "../../src/server/app";
import type { AppContext } from "../../src/server/context";
import { FAKE_TARGET, FAKE_TOKEN, fakeD1 } from "./fake-d1";

/**
 * Exit criterion: the Cloudflare token never appears in stdout, stderr, any
 * HTTP response or any error. Covers both token sources and every error path
 * the studio has for remote mode.
 */
const tmp = mkdtempSync(path.join(tmpdir(), "d1s-leak-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PORT = 4101;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "studio-session-token";

let output = "";
beforeEach(() => {
  output = "";
  const capture = (chunk: unknown) => {
    output += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output += `${args.map((a) => inspect(a, { depth: 10, showHidden: true })).join(" ")}\n`;
    });
  }
});
afterEach(() => vi.restoreAllMocks());

function project(): string {
  const dir = path.join(tmp, `p-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      account_id: FAKE_TARGET.accountId,
      d1_databases: [
        { binding: "DB", database_name: "fake-db", database_id: FAKE_TARGET.databaseId },
      ],
    }),
  );
  return dir;
}

const argv = (...args: string[]) => {
  const parsed = parseCli(["--remote", ...args]);
  if (parsed.kind !== "run") throw new Error("expected run");
  return parsed.options;
};

type Mode = "ok" | "rate-limit" | "down" | "offline" | "forbidden";

test.each([
  ["CLOUDFLARE_API_TOKEN", { CLOUDFLARE_API_TOKEN: FAKE_TOKEN }],
  ["wrangler auth token", {}],
])("the token never leaks (%s)", async (_, env) => {
  const fake = await fakeD1(path.join(tmp, `${Math.random().toString(36).slice(2)}.sqlite`));
  let mode: Mode = "ok";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const json = (status: number, message: string, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1, message }] }), {
        status,
        headers,
      });
    switch (mode) {
      case "rate-limit":
        return json(429, "Too many requests", { "Retry-After": "60" });
      case "down":
        // Retry-After: 0 keeps the read retries instant.
        return json(503, "Service unavailable", { "Retry-After": "0" });
      case "forbidden":
        return json(403, "Authentication error");
      case "offline":
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      default:
        return fake.fetch(input, init);
    }
  };
  const deps: RemoteDeps = {
    env,
    cwd: project(),
    tty: false,
    fetch,
    // `wrangler auth token --json`, with the token in stdout.
    run: async () => ({
      code: 0,
      stdout: `${JSON.stringify({ type: "oauth", token: FAKE_TOKEN }, null, 2)}\n`,
      stderr: "",
    }),
  };

  const texts: string[] = [];
  const errors: unknown[] = [];
  try {
    const opened = await openRemote(argv("--write", "--yes"), deps);
    console.log(opened);
    console.log(
      formatBanner({
        version: "1.0.0",
        mode: "remote",
        readOnly: false,
        database: opened.database,
        account: opened.account,
        source: opened.source,
        url: `${ORIGIN}/?t=${SESSION}`,
      }),
    );

    const ctx: AppContext = {
      version: "1.0.0",
      mode: "remote",
      readOnly: false,
      token: SESSION,
      bind: { host: "127.0.0.1", port: PORT },
      uiDir: tmp,
      session: opened.session,
      notices: [],
      // What the CLI does with unexpected errors.
      logError: (err) => console.error(err),
    };
    const app = createApp(ctx);
    const headers = { Cookie: `d1s_${PORT}=${SESSION}` };
    const get = (url: string) => app.request(`${ORIGIN}${url}`, { headers });
    const query = (sql: string) =>
      app.request(`${ORIGIN}/api/query`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ sql }),
      });

    const responses: Response[] = [
      await get("/api/meta"),
      await get("/api/usage"),
      await query(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB); INSERT INTO t (v) VALUES (x'00ff')",
      ),
      await get("/api/tables"),
      await get("/api/tables/counts"),
      await get("/api/tables/t/schema"),
      await get("/api/tables/t/rows?limit=50"),
      await get("/api/schema/all"),
      await query("SELECT * FROM t"),
      await query("SELECT * FROM nope"),
      await get("/api/tables/nope/schema"),
      await get("/"),
      await app.request(`${ORIGIN}/api/meta`),
    ];
    for (const m of ["rate-limit", "down", "offline", "forbidden"] as const) {
      mode = m;
      responses.push(await query("SELECT 1"), await get("/api/tables/counts?refresh=1"));
    }
    mode = "ok";
    for (const res of responses) {
      texts.push(`${res.status} ${[...res.headers].join(" ")} ${await res.text()}`);
    }
    expect(responses.map((r) => r.status)).toContain(429);
    expect(responses.map((r) => r.status)).toContain(502);
  } finally {
    fake.close();
  }

  // Startup failures.
  for (const m of ["forbidden", "down", "offline"] as const) {
    mode = m;
    errors.push(await openRemote(argv(), deps).catch((e: unknown) => e));
  }
  mode = "ok";
  errors.push(await openRemote(argv("--write"), deps).catch((e: unknown) => e));
  errors.push(await openRemote(argv("--db", "nope"), deps).catch((e: unknown) => e));

  for (const err of errors) {
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    texts.push(`${e.message}\n${e.stack}\n${inspect(e, { depth: 10, showHidden: true })}`);
  }
  texts.push(output);

  expect(output).toContain("fake-db");
  for (const text of texts) expect(text).not.toContain(FAKE_TOKEN);
});
