import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';

import { listen } from '../src/cli/port';
import { createApp } from '../src/server/app';
import { type AppContext, readySession } from '../src/server/context';
import { fakeD1 } from '../test/remote/fake-d1';
import { watchConsole } from './console';
import { makeEditDb } from './fixtures/make';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'e2e-remote-token';

export const REMOTE_DATABASE = 'prod-db';

/** A studio in remote write mode over a fake D1 API, running inside the test process. */
export interface RemoteStudio {
  /** The link with the session token. */
  url: string;
  /** Answers the next `times` requests to the D1 API with a 429. */
  rateLimit(times: number, retryAfter?: number): void;
  /** Statements the fake D1 API received, in order. */
  sent(): string[];
  /** Runs SQL straight against the fake's database. */
  sql(sql: string): Promise<unknown[][]>;
}

async function startRemoteStudio(): Promise<{ studio: RemoteStudio; stop: () => Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'd1s-e2e-remote-'));
  const file = path.join(dir, 'remote.sqlite');
  makeEditDb(file);

  let limited = 0;
  let retryAfter = 1;
  const fake = await fakeD1(file, {
    readOnly: false,
    intercept: (req) => {
      if (req.method !== 'POST' || limited === 0) return undefined;
      limited--;
      return {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
        body: {
          success: false,
          errors: [{ code: 7429, message: 'Too many requests' }],
          messages: [],
          result: null,
        },
      };
    },
  });
  const ctx: AppContext = {
    version: '0.0.0-e2e',
    mode: 'remote',
    readOnly: false,
    token: TOKEN,
    bind: { host: '127.0.0.1', port: 0 },
    uiDir: path.join(root, 'dist', 'ui'),
    session: readySession(fake.driver, { name: REMOTE_DATABASE, binding: 'DB', id: '3f2a9c1e' }),
    account: { id: 'a1b2c3d4e5f60718', name: 'Acme Inc' },
    notices: [],
    logError: (err) => console.error(err),
  };
  const { server, port } = await listen(createApp(ctx), '127.0.0.1', 0, true);
  ctx.bind.port = port;

  const studio: RemoteStudio = {
    url: `http://127.0.0.1:${port}/?t=${TOKEN}`,
    rateLimit(times, after = 1) {
      limited = times;
      retryAfter = after;
    },
    sent: () =>
      fake.requests.flatMap((r) => {
        const body = r.body as { sql?: string; batch?: { sql: string }[] } | undefined;
        return r.method === 'POST' ? (body?.batch?.map((s) => s.sql) ?? [body?.sql ?? '']) : [];
      }),
    sql: async (sql) => (await fake.driver.query(sql))[0]?.rows ?? [],
  };
  return {
    studio,
    stop: async () => {
      server.close();
      server.closeAllConnections();
      fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const test = base.extend<{ remote: RemoteStudio }>({
  remote: async ({ browserName: _ }, use) => {
    const { studio, stop } = await startRemoteStudio();
    await use(studio);
    await stop();
  },
  // As in studio.ts: every test fails on a browser console error.
  page: async ({ page, remote }, use) => {
    const errors = watchConsole(page);
    await page.goto(remote.url);
    await use(page);
    expect(errors, 'browser console errors').toEqual([]);
  },
});

export { expect };
