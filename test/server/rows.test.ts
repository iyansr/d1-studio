import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { LocalDriver } from '../../src/drivers/local';
import { createApp } from '../../src/server/app';
import { type AppContext, readySession } from '../../src/server/context';
import type { RowsPage } from '../../src/shared/rows';

const TOKEN = 't';
const PORT = 4101;
const BIG = 100_000;

const SCHEMA = `
  CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    age INTEGER,
    team_id INTEGER REFERENCES teams,
    avatar BLOB
  );
  CREATE TABLE tags (tag TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
  CREATE VIEW adults AS SELECT email, age FROM users WHERE age >= 18;
  CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT, n REAL);
  INSERT INTO teams VALUES (1, 'core');
  INSERT INTO users VALUES
    (1, 'ada@example.com', 36, 1, x'00010203'),
    (2, 'alan@example.com', 41, NULL, NULL),
    (3, 'kid@example.com', 9, 1, NULL),
    (4, 'grace@example.com', NULL, NULL, NULL);
  INSERT INTO tags VALUES ('b', 2), ('a', 1), ('c', 3);
  WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${BIG})
    INSERT INTO big SELECT i, 'row ' || i, i * 0.5 FROM s;
`;

const dir = mkdtempSync(path.join(tmpdir(), 'd1s-rows-'));
let driver: LocalDriver;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  driver = await LocalDriver.open(path.join(dir, 'rows.sqlite'), { readOnly: false });
  await driver.query(SCHEMA);
  const ctx: AppContext = {
    version: '0.0.0',
    mode: 'local',
    readOnly: false,
    token: TOKEN,
    bind: { host: '127.0.0.1', port: PORT },
    uiDir: dir,
    session: readySession(driver, { name: 'db', binding: 'DB', id: null }),
    notices: [],
    logError: () => {},
  };
  app = createApp(ctx);
}, 30_000);
afterAll(async () => {
  await driver.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(url: string) {
  const res = await app.request(`http://127.0.0.1:${PORT}${url}`, {
    headers: { Cookie: `d1s_${PORT}=${TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as RowsPage & { error?: unknown } };
}

const f = (filters: unknown[]) => encodeURIComponent(JSON.stringify(filters));

describe('GET /api/tables/:name/rows', () => {
  test('a rowid table: key, columns with PK and FK, encoded values', async () => {
    const { status, body } = await get('/api/tables/users/rows');
    expect(status).toBe(200);
    expect(body.key).toEqual({ kind: 'rowid', columns: ['__d1s_rowid'] });
    expect(body.columns).toEqual([
      { name: '__d1s_rowid', type: 'INTEGER', pk: 0 },
      { name: 'id', type: 'INTEGER', pk: 1 },
      { name: 'email', type: 'TEXT', pk: 0 },
      { name: 'age', type: 'INTEGER', pk: 0 },
      { name: 'team_id', type: 'INTEGER', pk: 0, fk: { table: 'teams', column: 'id' } },
      { name: 'avatar', type: 'BLOB', pk: 0 },
    ]);
    expect(body.rows[0]).toEqual([1, 1, 'ada@example.com', 36, 1, { $blob: 4 }]);
    expect(body.hasMore).toBe(false);
    expect(body.total).toBeUndefined();
  });

  test('sort, filter and count', async () => {
    const { body } = await get(
      `/api/tables/users/rows?sort=age:desc&f=${f([{ col: 'age', op: 'nnull' }])}&count=1`,
    );
    expect(body.rows.map((r) => r[2])).toEqual([
      'alan@example.com',
      'ada@example.com',
      'kid@example.com',
    ]);
    expect(body.total).toBe(3);
  });

  test('IS NULL and LIKE', async () => {
    const nulls = await get(`/api/tables/users/rows?f=${f([{ col: 'age', op: 'null' }])}`);
    expect(nulls.body.rows.map((r) => r[2])).toEqual(['grace@example.com']);
    const like = await get(
      `/api/tables/users/rows?f=${f([{ col: 'email', op: 'like', value: 'a%' }])}`,
    );
    expect(like.body.rows.map((r) => r[2])).toEqual(['ada@example.com', 'alan@example.com']);
  });

  test('hasMore and paging', async () => {
    const first = await get('/api/tables/big/rows?limit=50&count=1');
    expect(first.body.rows).toHaveLength(50);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.total).toBe(BIG);
    const last = await get(`/api/tables/big/rows?limit=100&offset=${BIG - 30}`);
    expect(last.body.rows).toHaveLength(30);
    expect(last.body.hasMore).toBe(false);
    expect(last.body.rows[0]?.[1]).toBe(BIG - 29);
  });

  test('WITHOUT ROWID tables key on the PK; views have no key', async () => {
    const tags = await get('/api/tables/tags/rows');
    expect(tags.body.key).toEqual({ kind: 'pk', columns: ['tag'] });
    expect(tags.body.rows).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const adults = await get('/api/tables/adults/rows?sort=age:asc');
    expect(adults.body.key).toEqual({ kind: 'none', columns: [] });
    expect(adults.body.rows).toEqual([
      ['ada@example.com', 36],
      ['alan@example.com', 41],
    ]);
  });

  test.each([
    ['unknown table', '/api/tables/nope/rows', 404, 'No such table: nope'],
    [
      'injected column',
      `/api/tables/users/rows?sort=${encodeURIComponent('x" OR 1=1 --:asc')}`,
      400,
      'No such column: users.x" OR 1=1 --',
    ],
    [
      'unknown op',
      `/api/tables/users/rows?f=${f([{ col: 'age', op: 'regexp', value: '1' }])}`,
      400,
      'Unknown filter op "regexp".',
    ],
    ['bad limit', '/api/tables/users/rows?limit=1000', 400, '"limit" must be one of 50, 100, 500.'],
  ])('%s', async (_, url, status, message) => {
    const res = await get(url);
    expect(res.status).toBe(status);
    expect(res.body.error).toEqual({ message });
  });

  test('100k rows: a 500-row page at offset 0 and 90 000', async () => {
    for (const offset of [0, 90_000]) {
      await get(`/api/tables/big/rows?limit=500&offset=${offset}`); // warm
      const started = performance.now();
      const { body } = await get(`/api/tables/big/rows?limit=500&offset=${offset}`);
      const ms = performance.now() - started;
      console.log(`big: 500 rows at offset ${offset} in ${ms.toFixed(1)} ms`);
      expect(body.rows).toHaveLength(500);
      expect(body.rows[0]?.[1]).toBe(offset + 1);
      expect(ms).toBeLessThan(250);
    }
  });
});

describe('GET /api/schema/all', () => {
  test('every table and view with its columns', async () => {
    const { body } = (await get('/api/schema/all')) as unknown as {
      body: { tables: { name: string; type: string; columns: { name: string; type: string }[] }[] };
    };
    expect(body.tables.find((t) => t.name === 'adults')).toEqual({
      name: 'adults',
      type: 'view',
      columns: [
        { name: 'email', type: 'TEXT' },
        { name: 'age', type: 'INTEGER' },
      ],
    });
    expect(body.tables.find((t) => t.name === 'tags')?.columns.map((c) => c.name)).toEqual([
      'tag',
      'n',
    ]);
  });
});
