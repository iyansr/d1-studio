import { describe, expect, test } from 'vitest';

import { API_BASE, D1ApiError, D1Client, parseRetryAfter } from '../../src/remote/client';
import { Secret } from '../../src/remote/secret';
import { type Canned, fixture, sequence, stubFetch } from './stub';

const TOKEN = 'cf-test-token-0123456789abcdef';
const target = { accountId: 'acc-1', databaseId: 'db 1' };

function client(fetch: typeof globalThis.fetch, sleeps: number[] = []) {
  return new D1Client({
    token: new Secret(TOKEN),
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
}

describe('requests', () => {
  test('raw posts { sql, params } with the bearer token to api.cloudflare.com only', async () => {
    const stub = sequence(fixture('raw-select'));
    const results = await client(stub.fetch).raw(
      target,
      { sql: 'SELECT ?1', params: [1] },
      { retry: true },
    );
    expect(results).toHaveLength(1);
    const [req] = stub.requests;
    expect(req?.method).toBe('POST');
    expect(req?.url.origin).toBe(new URL(API_BASE).origin);
    expect(req?.url.pathname).toBe('/client/v4/accounts/acc-1/d1/database/db%201/raw');
    expect(req?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers.get('content-type')).toBe('application/json');
    expect(req?.body).toEqual({ sql: 'SELECT ?1', params: [1] });
  });

  test('batch posts { batch: [...] }', async () => {
    const stub = sequence(fixture('raw-multi'));
    const results = await client(stub.fetch).batch(
      target,
      [{ sql: 'INSERT INTO t VALUES (1)' }, { sql: 'SELECT 1', params: [] }],
      { retry: false },
    );
    expect(results).toHaveLength(2);
    expect(stub.requests[0]?.body).toEqual({
      batch: [{ sql: 'INSERT INTO t VALUES (1)' }, { sql: 'SELECT 1', params: [] }],
    });
  });

  test('listDatabases follows pagination', async () => {
    const stub = sequence(fixture('databases-page1'), fixture('databases-page2'));
    const dbs = await client(stub.fetch).listDatabases('acc-1');
    expect(dbs.map((d) => d.name)).toEqual(['prod-db', 'staging-db', 'analytics']);
    expect(stub.requests.map((r) => r.url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(stub.requests[0]?.method).toBe('GET');
    expect(stub.requests[0]?.body).toBeUndefined();
  });

  test('listAccounts and getDatabase', async () => {
    const accounts = await client(sequence(fixture('accounts')).fetch).listAccounts();
    expect(accounts.map((a) => a.name)).toEqual(['Acme Inc', 'Side Project']);
    const db = await client(sequence(fixture('database')).fetch).getDatabase('acc-1', '3f2a');
    expect(db.name).toBe('prod-db');
  });
});

describe('errors', () => {
  test("the API's message is kept verbatim, with status and code", async () => {
    const err = await client(sequence(fixture('error-sql')).fetch)
      .raw(target, { sql: 'SELECT * FROM nope' }, { retry: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D1ApiError);
    expect(err).toMatchObject({
      message: 'no such table: nope: SQLITE_ERROR',
      status: 400,
      code: 7500,
      rateLimited: false,
    });
  });

  test('a body without errors gets a generic message', async () => {
    const stub = stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await client(stub.fetch)
      .raw(target, { sql: 'SELECT 1' }, { retry: false })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: 'Cloudflare API request failed (HTTP 502).',
      status: 502,
    });
  });

  test('success: false on HTTP 200 is an error', async () => {
    const body: Canned = {
      status: 200,
      body: { success: false, errors: [{ code: 7400, message: 'bad' }], result: null },
    };
    await expect(
      client(sequence(body).fetch).raw(target, { sql: 'x' }, { retry: false }),
    ).rejects.toMatchObject({ message: 'bad', status: 200 });
  });

  test('network failure and timeout', async () => {
    const offline = stubFetch(
      () => new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }),
    );
    await expect(
      client(offline.fetch).raw(target, { sql: 'SELECT 1' }, { retry: true }),
    ).rejects.toMatchObject({
      message: "Couldn't reach the Cloudflare API: getaddrinfo ENOTFOUND",
      status: 0,
    });
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    await expect(
      client(stubFetch(() => timeout).fetch).raw(target, { sql: 'SELECT 1' }, { retry: true }),
    ).rejects.toMatchObject({
      message: "The Cloudflare API didn't answer within 30 s.",
      status: 0,
    });
  });
});

describe('retries', () => {
  test('a read retries 429 and 5xx, honouring Retry-After', async () => {
    const sleeps: number[] = [];
    const stub = sequence(
      fixture('error-rate-limit'),
      fixture('error-server'),
      fixture('raw-select'),
    );
    const results = await client(stub.fetch, sleeps).raw(
      target,
      { sql: 'SELECT 1' },
      { retry: true },
    );
    expect(results).toHaveLength(1);
    expect(stub.requests).toHaveLength(3);
    // Retry-After: 7, then jittered backoff for attempt 1 (500 ms × 1.0).
    expect(sleeps).toEqual([7000, 500]);
  });

  test('gives up after 3 retries and surfaces the rate limit', async () => {
    const sleeps: number[] = [];
    const stub = sequence(fixture('error-rate-limit'));
    const err = await client(stub.fetch, sleeps)
      .raw(target, { sql: 'SELECT 1' }, { retry: true })
      .catch((e: unknown) => e);
    expect(stub.requests).toHaveLength(4);
    expect(err).toMatchObject({ status: 429, rateLimited: true, retryAfter: 7 });
  });

  test('writes are never retried', async () => {
    const stub = sequence(fixture('error-server'), fixture('raw-multi'));
    await expect(
      client(stub.fetch).raw(target, { sql: 'DELETE FROM t' }, { retry: false }),
    ).rejects.toMatchObject({ status: 503 });
    expect(stub.requests).toHaveLength(1);
  });

  test('a Retry-After beyond 10 s is surfaced, not waited out', async () => {
    const sleeps: number[] = [];
    const long: Canned = { ...fixture('error-rate-limit'), headers: { 'Retry-After': '60' } };
    const stub = sequence(long);
    await expect(
      client(stub.fetch, sleeps).raw(target, { sql: 'SELECT 1' }, { retry: true }),
    ).rejects.toMatchObject({ rateLimited: true, retryAfter: 60 });
    expect(sleeps).toEqual([]);
    expect(stub.requests).toHaveLength(1);
  });

  test('client errors are not retried', async () => {
    const stub = sequence(fixture('error-sql'));
    await expect(
      client(stub.fetch).raw(target, { sql: 'SELECT 1' }, { retry: true }),
    ).rejects.toBeInstanceOf(D1ApiError);
    expect(stub.requests).toHaveLength(1);
  });
});

test('parseRetryAfter', () => {
  expect(parseRetryAfter(null)).toBeUndefined();
  expect(parseRetryAfter('12')).toBe(12);
  expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.UTC(2015, 9, 21, 7, 28, 0))).toBe(
    10,
  );
  expect(parseRetryAfter('soon')).toBeUndefined();
});
