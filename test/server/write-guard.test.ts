import { beforeEach, describe, expect, test } from 'vitest';

import { LocalDriver } from '../../src/drivers/local';
import type { WritePreview } from '../../src/shared/edits';
import { fakeD1 } from '../remote/fake-d1';
import { copyFixtureDb, type Harness, harness, scratchDir } from './harness';

const dir = scratchDir('d1s-guard-');

const query = (h: Harness, sql: string, confirm?: true | string) =>
  h.post('/api/query', confirm === undefined ? { sql } : { sql, confirm });
const body = async (res: Response) =>
  (await res.json()) as {
    error?: { message: string; code?: string };
    preview?: WritePreview;
    results?: unknown[];
  };

describe('the SQL editor in remote write mode (mocked D1)', () => {
  let fake: Awaited<ReturnType<typeof fakeD1>>;
  let h: Harness;
  beforeEach(async () => {
    fake = await fakeD1(copyFixtureDb(dir), { readOnly: false });
    h = harness(fake.driver);
    return () => fake.close();
  });
  const count = async (table: string) =>
    (await fake.driver.query(`SELECT count(*) FROM ${table}`))[0]?.rows[0]?.[0];
  const tableExists = async (name: string) =>
    (await fake.driver.query(`SELECT 1 FROM sqlite_schema WHERE name = '${name}'`))[0]?.rows
      .length === 1;

  test.each([
    'DROP TABLE sessions',
    'DELETE FROM sessions',
    "UPDATE users SET name = 'x'",
    'ALTER TABLE users DROP COLUMN name',
    'SELECT 1; DELETE FROM sessions',
  ])('%s answers 409 with the statements and does not run', async (sql) => {
    const res = await query(h, sql);
    expect(res.status).toBe(409);
    const { error, preview } = await body(res);
    expect(error?.code).toBe('confirmation_required');
    expect(preview).toMatchObject({ dangerous: true, requiresConfirm: 'type-name' });
    expect(preview?.statements.at(-1)).toMatchObject({ dangerous: true });
    expect(await count('sessions')).toBe(3);
    expect(await tableExists('sessions')).toBe(true);
    expect(await count('users')).toBe(2);
  });

  test('a wrong name answers 403 and does not run', async () => {
    for (const wrong of [true, 'prod', 'PROD-DB', 'fake-db'] as const) {
      const res = await query(h, 'DROP TABLE sessions', wrong);
      expect(res.status).toBe(403);
      expect((await body(res)).error?.code).toBe('confirmation_mismatch');
    }
    expect(await tableExists('sessions')).toBe(true);
  });

  test('the right name runs it', async () => {
    const res = await query(h, 'DROP TABLE sessions', 'prod-db');
    expect(res.status).toBe(200);
    expect(await tableExists('sessions')).toBe(false);
  });

  test('one dangerous statement holds back the whole request', async () => {
    const res = await query(h, "INSERT INTO users (email) VALUES ('z@z.z'); DROP TABLE sessions");
    expect(res.status).toBe(409);
    expect(await count('users')).toBe(2);
  });

  test.each([
    "INSERT INTO users (email) VALUES ('z@z.z')",
    "UPDATE users SET name = 'x' WHERE id = 1",
    "DELETE FROM sessions WHERE id = 's1'",
    'CREATE TABLE extra (a)',
    'ALTER TABLE users ADD COLUMN age INTEGER',
    'SELECT * FROM users',
  ])('%s runs without a dialog: the user wrote it', async (sql) => {
    const res = await query(h, sql);
    expect(res.status).toBe(200);
  });

  test('a bad confirm is a 400', async () => {
    const res = await h.post('/api/query', { sql: 'SELECT 1', confirm: false });
    expect(res.status).toBe(400);
  });
});

describe('local mode has no dialogs', () => {
  test('destructive SQL runs, with or without a confirm', async () => {
    const driver = await LocalDriver.open(copyFixtureDb(dir), { readOnly: false });
    const h = harness(driver);
    expect((await query(h, 'DELETE FROM sessions')).status).toBe(200);
    expect((await query(h, 'DROP TABLE users', 'wrong')).status).toBe(200);
    expect(
      (await driver.query("SELECT name FROM sqlite_schema WHERE name = 'users'"))[0]?.rows,
    ).toEqual([]);
    await driver.close();
  });
});

describe('read-only wins over the guard', () => {
  test('a destructive statement is a plain 403', async () => {
    const fake = await fakeD1(copyFixtureDb(dir), { readOnly: true });
    const h = harness(fake.driver);
    const res = await query(h, 'DROP TABLE users', 'prod-db');
    expect(res.status).toBe(403);
    expect((await body(res)).error?.code).toBeUndefined();
    fake.close();
  });
});
