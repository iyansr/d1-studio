import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import type { Driver } from "../../src/drivers/types";
import { d1StateDir } from "../../src/local/locate";
import { createApp } from "../../src/server/app";
import { type AppContext, readySession } from "../../src/server/context";
import { DB_FILE } from "../fixtures/make";

export const TOKEN = "session-token";
export const PORT = 4101;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

/** A scratch dir per test file, removed afterwards. */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fixtureDb = path.join(
  d1StateDir(path.resolve(import.meta.dirname, "../fixtures/project-two-dbs/.wrangler/state")),
  DB_FILE,
);

/** A copy of the fixture database (users, sessions) in `dir`. */
export function copyFixtureDb(dir: string): string {
  const file = path.join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  copyFileSync(fixtureDb, file);
  return file;
}

export interface Harness {
  ctx: AppContext;
  get: (url: string) => Promise<Response>;
  post: (url: string, body: unknown) => Promise<Response>;
}

/** The studio app over `driver`, driven through `app.request()` with a valid session. */
export function harness(driver: Driver, overrides: Partial<AppContext> = {}): Harness {
  const ctx: AppContext = {
    version: "1.2.3",
    mode: driver.mode,
    readOnly: driver.readOnly,
    token: TOKEN,
    bind: { host: "127.0.0.1", port: PORT },
    uiDir: tmpdir(),
    session: readySession(driver, { name: "prod-db", binding: "DB", id: "3f2a" }),
    notices: [],
    logError: () => {},
    ...overrides,
  };
  const app = createApp(ctx);
  const cookie = { Cookie: `d1s_${PORT}=${TOKEN}` };
  return {
    ctx,
    get: async (url) => app.request(`${ORIGIN}${url}`, { headers: cookie }),
    post: async (url, body) =>
      app.request(`${ORIGIN}${url}`, {
        method: "POST",
        headers: { ...cookie, "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify(body),
      }),
  };
}
