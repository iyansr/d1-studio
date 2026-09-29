import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { DB_FILE } from "../fixtures/make";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "dist", "cli.js");
const project = path.join(root, "test", "fixtures", "project-two-dbs");
const state = path.join(project, ".wrangler", "state");
const runtime = process.env.D1_STUDIO_SMOKE_RUNTIME === "bun" ? "bun" : process.execPath;

const tmp = mkdtempSync(path.join(tmpdir(), "d1s-smoke-"));
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("dist/cli.js is missing; run `pnpm build` first.");
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

interface Started {
  child: ChildProcess;
  stdout: () => string;
  url: URL;
  readyMs: number;
  wallMs: number;
}

/** Starts the CLI and waits for the banner's studio line. */
async function start(args: string[], cwd: string, envPort?: number): Promise<Started> {
  const port = envPort ?? (await freePort());
  const began = performance.now();
  const child = spawn(runtime, [cli, "--no-open", ...args], {
    cwd,
    env: { ...process.env, DEBUG: "d1-studio", D1_STUDIO_PORT: String(port), NO_COLOR: "1" },
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    err += d;
  });
  const url = await new Promise<URL>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout\n${out}\n${err}`)), 15_000);
    const check = () => {
      const match = /studio\s+(http:\/\/\S+)/.exec(out);
      if (match?.[1] && /ready in \d+ ms/.test(err)) {
        clearTimeout(timer);
        resolve(new URL(match[1]));
      }
    };
    child.stdout?.on("data", check);
    child.stderr?.on("data", check);
    child.once("exit", (code) => reject(new Error(`exited ${code}\n${out}\n${err}`)));
  });
  const wallMs = performance.now() - began;
  const readyMs = Number(/ready in (\d+) ms/.exec(err)?.[1]);
  return { child, stdout: () => out, url, readyMs, wallMs };
}

/** Runs the CLI to completion. */
function run(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(runtime, [cli, "--no-open", ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    child.once("exit", (code) => resolve({ code, output }));
  });
}

/** node:http so we can send any Host header. */
function raw(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function login(url: URL): Promise<string> {
  const res = await raw(url);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/");
  const cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
  expect(cookie).toMatch(/^d1s_\d+=/);
  return cookie;
}

describe(`smoke (${path.basename(runtime)})`, () => {
  test("project-two-dbs: banner, cookie login, tables, security", async () => {
    const s = await start(["--db", "DB"], project);
    console.log(
      `server ready in ${s.readyMs} ms from process start (${s.wallMs.toFixed(0)} ms wall)`,
    );
    expect(s.readyMs).toBeLessThan(1500);

    const banner = s.stdout();
    expect(banner).toMatch(/^d1-studio v\d+\.\d+\.\d+/);
    expect(banner).toContain("mode      local (read-write)");
    expect(banner).toContain("database  app-db (binding DB, id 3f2a…)");
    expect(banner).toContain("config    ./wrangler.jsonc");
    expect(banner).toContain(
      "note      writes here can make concurrent `wrangler dev` writes fail",
    );
    expect(s.url.searchParams.get("t")).toMatch(/^[\w-]{43}$/);

    const origin = `http://${s.url.host}`;
    const api = (p: string) => new URL(p, origin);
    const cookie = await login(s.url);

    const tables = await raw(api("/api/tables"), { headers: { Cookie: cookie } });
    expect(tables.status).toBe(200);
    const visible = (JSON.parse(tables.body).tables as { name: string; hidden: boolean }[])
      .filter((t) => !t.hidden)
      .map((t) => t.name);
    expect(visible).toEqual(["sessions", "users"]);

    const page = await raw(api("/"), { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("d1-studio");

    expect((await raw(api("/api/tables"))).status).toBe(401);
    expect(
      (await raw(api("/api/tables"), { headers: { Cookie: cookie, Host: "evil.test" } })).status,
    ).toBe(403);
    const crossOrigin = await raw(api("/api/query"), {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://evil.test", "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(crossOrigin.status).toBe(403);

    const bad = await raw(api("/api/query"), {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT * FROM nope" }),
    });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({
      error: { message: "no such table: nope", statementIndex: 0 },
    });
    expect((await raw(api("/api/meta"), { headers: { Cookie: cookie } })).status).toBe(200);

    if (process.platform !== "win32") {
      const exit = new Promise<number | null>((r) => s.child.once("exit", r));
      s.child.kill("SIGTERM");
      expect(await exit).toBe(0);
    }
  });

  test("--no-write opens read-only", async () => {
    const s = await start(["--db", "ANALYTICS", "--no-write"], project);
    expect(s.stdout()).toContain("mode      local (read-only)");
    expect(s.stdout()).not.toContain("wrangler dev");
    const cookie = await login(s.url);
    const res = await raw(new URL("/api/query", s.url), {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: `http://${s.url.host}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql: "DELETE FROM events" }),
    });
    // The server refuses it (T5) before the read-only file would (defence in depth).
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe(
      "Read-only mode: DELETE is not allowed. Restart with --write to enable edits.",
    );
  });

  test("a positional path skips discovery", async () => {
    const file = path.join(state, "v3", "d1", "miniflare-D1DatabaseObject", DB_FILE);
    const s = await start(["--local", file, "--no-write"], tmp);
    expect(s.stdout()).toContain(`database  ${DB_FILE}`);
    expect(s.stdout()).toMatch(/file\s+\S+\.sqlite/);
  });

  test("needs-db when no file matches the binding", async () => {
    const dir = path.join(tmp, "needs-db");
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      '[[d1_databases]]\nbinding = "DB"\ndatabase_id = "unknown"\n',
    );
    const s = await start(["--persist-to", state, "--no-write"], dir);
    expect(s.stdout()).toContain("no file matched; pick one of 2 in the studio");
    const cookie = await login(s.url);
    const meta = await raw(new URL("/api/meta", s.url), { headers: { Cookie: cookie } });
    expect(JSON.parse(meta.body)).toMatchObject({ state: "needs-db", database: null });
    const list = await raw(new URL("/api/candidates", s.url), { headers: { Cookie: cookie } });
    expect(JSON.parse(list.body).candidates).toHaveLength(2);
  });

  test("fails clearly outside a Wrangler project and with no local state", async () => {
    const empty = path.join(tmp, "empty");
    mkdirSync(path.join(empty, ".git"), { recursive: true });
    const none = await run([], empty);
    expect(none.code).toBe(1);
    expect(none.output).toContain("No wrangler.json, wrangler.jsonc or wrangler.toml found");

    const fresh = path.join(tmp, "fresh");
    mkdirSync(path.join(fresh, ".git"), { recursive: true });
    writeFileSync(
      path.join(fresh, "wrangler.json"),
      '{"d1_databases":[{"binding":"DB","database_id":"x"}]}',
    );
    const noState = await run([], fresh);
    expect(noState.code).toBe(1);
    expect(noState.output).toContain(
      "Run `wrangler dev` or `wrangler d1 migrations apply --local` first.",
    );

    const multi = await run([], project);
    expect(multi.code).toBe(1);
    expect(multi.output).toContain("Multiple D1 databases: DB, ANALYTICS. Pass --db <name>.");
  });

  test("an explicit busy --port fails; the default falls through", async () => {
    const first = await start(["--db", "DB"], project);
    const busy = first.url.port;
    const strict = await run(["--db", "DB", "--port", busy], project);
    expect(strict.code).toBe(1);
    expect(strict.output).toContain(`Port ${busy} is in use. Choose another with \`--port\`.`);

    const second = await start(["--db", "DB"], project, Number(busy));
    expect(Number(second.url.port)).toBeGreaterThan(Number(busy));
    expect(second.stdout()).toContain(`note      port ${busy} was in use`);
  });

  test("--version and --help", async () => {
    const version = await run(["--version"], tmp);
    expect(version.code).toBe(0);
    expect(version.output.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = await run(["--help"], tmp);
    expect(help.code).toBe(0);
    expect(help.output).toContain("--persist-to");
  });
});
