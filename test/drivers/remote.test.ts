import { describe, expect, test } from 'vitest';

import { decodeCell, encodeParam, RemoteDriver } from '../../src/drivers/remote';
import { BatchError, DbError } from '../../src/drivers/types';
import { D1ApiError, D1Client, NO_D1_ACCESS } from '../../src/remote/client';
import { Secret } from '../../src/remote/secret';
import { type Canned, fixture, sequence, stubFetch } from '../remote/stub';

const target = { accountId: 'acc-1', databaseId: 'db-1' };

function driver(stub: { fetch: typeof fetch }, readOnly = true) {
  const client = new D1Client({ token: new Secret('t'), fetch: stub.fetch, sleep: async () => {} });
  return new RemoteDriver(client, target, readOnly);
}

describe('query', () => {
  test('decodes /raw rows: duplicate columns, blobs, nulls, D1 meta', async () => {
    const stub = sequence(fixture('raw-select'));
    const d = driver(stub);
    const [result] = await d.query('SELECT a.id, b.id, score, avatar, note FROM a JOIN b');
    expect(result).toEqual({
      columns: ['id', 'id', 'score', 'avatar', 'note'],
      rows: [
        [1, 10, 9.5, { $blob: 4 }, 'first'],
        [2, 20, null, null, null],
        [9007199254740992, 30, 0, { $blob: 0 }, ''],
      ],
      durationMs: 0.21,
      rowsRead: 3,
      rowsWritten: 0,
    });
    expect(d.usage).toEqual({ rowsRead: 3, rowsWritten: 0 });
    expect(d.mode).toBe('remote');
    expect(d.readOnly).toBe(true);
  });

  test('several statements go in one request, one result each', async () => {
    const stub = sequence(fixture('raw-multi'));
    const d = driver(stub, false);
    const sql = 'INSERT INTO t (n) VALUES (41), (42); SELECT max(n) AS n FROM t';
    const results = await d.query(sql);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.body).toEqual({ sql });
    expect(results[0]).toEqual({
      columns: [],
      rows: [],
      changes: 2,
      lastRowId: 42,
      durationMs: 0.5,
      rowsRead: 0,
      rowsWritten: 2,
    });
    expect(results[1]).toMatchObject({ columns: ['n'], rows: [[42]] });
    expect(d.usage).toEqual({ rowsRead: 1, rowsWritten: 2 });
  });

  test('an empty result keeps its columns', async () => {
    const [result] = await driver(sequence(fixture('raw-empty'))).query('SELECT id FROM t');
    expect(result).toMatchObject({ columns: ['id'], rows: [] });
  });

  test('params are encoded for the API', async () => {
    const stub = sequence(fixture('raw-empty'));
    await driver(stub).query('SELECT ?, ?, ?, ?, ?', [
      1,
      'a',
      null,
      true,
      { $int: '9007199254740993' },
    ]);
    expect(stub.requests[0]?.body).toEqual({
      sql: 'SELECT ?, ?, ?, ?, ?',
      params: [1, 'a', null, 1, '9007199254740993'],
    });
  });

  test('params with several statements are refused before any request', async () => {
    const stub = sequence(fixture('raw-empty'));
    await expect(driver(stub).query('SELECT ?; SELECT 2', [1])).rejects.toBeInstanceOf(DbError);
    expect(stub.requests).toHaveLength(0);
  });

  test('blank SQL makes no request', async () => {
    const stub = sequence(fixture('raw-empty'));
    expect(await driver(stub).query('  -- nothing\n')).toEqual([]);
    expect(stub.requests).toHaveLength(0);
  });

  test('reads are retried, writes are not', async () => {
    const read = sequence(fixture('error-server'), fixture('raw-empty'));
    await driver(read).query('SELECT id FROM t');
    expect(read.requests).toHaveLength(2);

    const write = sequence(fixture('error-server'), fixture('raw-multi'));
    await expect(driver(write, false).query('SELECT 1; DELETE FROM t')).rejects.toBeInstanceOf(
      D1ApiError,
    );
    expect(write.requests).toHaveLength(1);
  });
});

describe('errors', () => {
  test("a SQL error is a DbError with D1's message verbatim", async () => {
    const err = await driver(sequence(fixture('error-sql')))
      .query('SELECT * FROM nope')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({ message: 'no such table: nope: SQLITE_ERROR' });
  });

  test('a 403 gets the permission hint', async () => {
    const err = await driver(sequence(fixture('error-auth')))
      .query('SELECT 1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D1ApiError);
    expect(err).toMatchObject({ message: NO_D1_ACCESS, status: 403 });
  });

  test.each([
    ['error-rate-limit', 429],
    ['error-unauthenticated', 401],
  ])('%s stays an API error', async (name, status) => {
    const long: Canned = { ...fixture(name), headers: { 'Retry-After': '60' } };
    const err = await driver(sequence(long))
      .query('SELECT 1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D1ApiError);
    expect(err).toMatchObject({ status });
  });
});

describe('batch', () => {
  test('sends { batch } in one request', async () => {
    const stub = sequence(fixture('raw-multi'));
    const results = await driver(stub, false).batch([
      { sql: 'INSERT INTO t (n) VALUES (?)', params: [true] },
      { sql: 'SELECT max(n) AS n FROM t' },
    ]);
    expect(results).toHaveLength(2);
    expect(stub.requests[0]?.body).toEqual({
      batch: [
        { sql: 'INSERT INTO t (n) VALUES (?)', params: [1] },
        { sql: 'SELECT max(n) AS n FROM t' },
      ],
    });
  });

  test('an entry with two statements is refused with its index', async () => {
    const stub = sequence(fixture('raw-multi'));
    const err = await driver(stub, false)
      .batch([{ sql: 'SELECT 1' }, { sql: 'SELECT 1; SELECT 2' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchError);
    expect(err).toMatchObject({ index: 1 });
    expect(stub.requests).toHaveLength(0);
  });

  test('a failed batch is a DbError', async () => {
    const stub = stubFetch(() => fixture('error-sql'));
    await expect(
      driver(stub, false).batch([{ sql: 'INSERT INTO nope VALUES (1)' }]),
    ).rejects.toBeInstanceOf(DbError);
  });
});

test('encodeParam and decodeCell', () => {
  expect(encodeParam(false)).toBe(0);
  expect(() => encodeParam({ $int: '12x' })).toThrow(DbError);
  expect(decodeCell(undefined)).toBeNull();
  expect(decodeCell([1, 2, 3])).toEqual({ $blob: 3 });
  expect(decodeCell({ a: 1 })).toBe('{"a":1}');
});
