import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CliOptions, parseCli } from '../../src/cli/args';
import { confirmRemoteWrite, NEEDS_YES } from '../../src/cli/confirm';
import { openRemote, type RemoteDeps } from '../../src/cli/remote';
import { UserError } from '../../src/errors';
import { FAKE_ACCOUNT, FAKE_DATABASE, FAKE_TARGET, FAKE_TOKEN, fakeD1 } from '../remote/fake-d1';

const tmp = mkdtempSync(path.join(tmpdir(), 'd1s-cli-remote-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const OTHER = { uuid: 'c0ffee00-1111-4222-8333-444455556666', name: 'analytics' };

let fake: Awaited<ReturnType<typeof fakeD1>>;
beforeEach(async () => {
  fake = await fakeD1(path.join(tmp, `${Math.random().toString(36).slice(2)}.sqlite`), {
    databases: [FAKE_DATABASE, OTHER],
  });
  return () => fake.close();
});

/** A project dir; `config` is written as wrangler.jsonc unless null. */
function project(config: object | null): string {
  const dir = path.join(tmp, `p-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (config) writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify(config));
  return dir;
}

const options = (...argv: string[]): CliOptions => {
  const parsed = parseCli(['--remote', ...argv]);
  if (parsed.kind !== 'run') throw new Error('expected run');
  return parsed.options;
};

function deps(cwd: string, overrides: Partial<RemoteDeps> = {}): RemoteDeps {
  return {
    env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: FAKE_TARGET.accountId },
    cwd,
    tty: false,
    fetch: fake.fetch,
    run: async () => ({ code: 1, stdout: '', stderr: 'Not logged in.' }),
    print: () => {},
    ...overrides,
  };
}

const withBinding = (binding: object) => ({ name: 'app', d1_databases: [binding] });

describe('database from the config', () => {
  test("a binding's database_id, probed through the API", async () => {
    const dir = project(
      withBinding({ binding: 'DB', database_name: 'fake-db', database_id: FAKE_TARGET.databaseId }),
    );
    const opened = await openRemote(options(), deps(dir));
    expect(opened.database).toBe('fake-db (binding DB, id db-f…)');
    expect(opened.source).toEqual({ label: 'config', value: './wrangler.jsonc' });
    expect(opened.account).toBe(`${FAKE_TARGET.accountId}, via CLOUDFLARE_API_TOKEN`);
    expect(opened.driver.readOnly).toBe(true);
    expect(opened.session).toMatchObject({
      state: 'ready',
      database: { name: 'fake-db', binding: 'DB', id: FAKE_TARGET.databaseId },
    });
    const [result] = await opened.driver.query('SELECT 1 AS one');
    expect(result?.rows).toEqual([[1]]);
    expect(fake.requests.map((r) => `${r.method} ${r.url.pathname}`)).toContain(
      `GET /client/v4/accounts/${FAKE_TARGET.accountId}/d1/database/${FAKE_TARGET.databaseId}`,
    );
  });

  test('a binding with only database_name is looked up by name', async () => {
    const dir = project(withBinding({ binding: 'DB', database_name: 'fake-db' }));
    const opened = await openRemote(options(), deps(dir));
    expect(opened.session).toMatchObject({ database: { id: FAKE_TARGET.databaseId } });
  });

  test('--db not in the config is looked up in the account', async () => {
    const dir = project(
      withBinding({ binding: 'DB', database_name: 'fake-db', database_id: FAKE_TARGET.databaseId }),
    );
    const opened = await openRemote(options('--db', 'analytics'), deps(dir));
    expect(opened.session).toMatchObject({
      database: { name: 'analytics', binding: null, id: OTHER.uuid },
    });
    await expect(openRemote(options('--db', 'nope'), deps(dir))).rejects.toThrow(
      /No D1 binding or database named "nope" in \.\/wrangler\.jsonc \(DB\), nor in the account\./,
    );
  });

  test('an unknown database_id and a token without D1 access', async () => {
    const dir = project(withBinding({ binding: 'DB', database_id: 'missing' }));
    await expect(openRemote(options(), deps(dir))).rejects.toThrow(
      /No D1 database missing in account acc-fake/,
    );
    const denied = project(withBinding({ binding: 'DB', database_id: FAKE_TARGET.databaseId }));
    const forbid = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'no' }] }), {
        status: 403,
      });
    await expect(openRemote(options(), deps(denied, { fetch: forbid }))).rejects.toThrow(
      'Token lacks D1 access (needs "D1 Read"; "D1 Edit" for --write).',
    );
  });

  test('the account comes from the config when the env has none', async () => {
    const dir = project({
      ...withBinding({ binding: 'DB', database_id: FAKE_TARGET.databaseId }),
      account_id: FAKE_TARGET.accountId,
    });
    const opened = await openRemote(
      options(),
      deps(dir, { env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN } }),
    );
    expect(opened.session).toMatchObject({ state: 'ready' });
  });
});

describe('no config (T8)', () => {
  test('--db picks by name', async () => {
    const opened = await openRemote(options('--db', 'analytics'), deps(project(null)));
    expect(opened.source).toBeUndefined();
    expect(opened.database).toBe('analytics (id c0ff…)');
  });

  test('a TTY gets a select', async () => {
    const selectDatabase = vi.fn(async (dbs: { name: string }[]) => dbs[0] as never);
    const opened = await openRemote(options(), deps(project(null), { tty: true, selectDatabase }));
    expect(selectDatabase).toHaveBeenCalledWith([FAKE_DATABASE, OTHER]);
    expect(opened.session).toMatchObject({ database: { name: 'fake-db' } });
  });

  test('no TTY and no --db fails with the list', async () => {
    await expect(openRemote(options(), deps(project(null)))).rejects.toThrow(
      'Pass --db <name> to pick a D1 database. Available: fake-db, analytics.',
    );
  });

  test('a config without D1 bindings behaves the same', async () => {
    const opened = await openRemote(options('--db', 'fake-db'), deps(project({ name: 'app' })));
    expect(opened.session).toMatchObject({ database: { name: 'fake-db', binding: null } });
  });

  test('the account comes from the API when nothing names it', async () => {
    const opened = await openRemote(
      options('--db', 'fake-db'),
      deps(project(null), { env: { CLOUDFLARE_API_TOKEN: FAKE_TOKEN } }),
    );
    expect(opened.account).toBe('Fake Co (acc-…), via CLOUDFLARE_API_TOKEN');
  });

  test('no credentials at all', async () => {
    await expect(
      openRemote(options('--db', 'fake-db'), deps(project(null), { env: {} })),
    ).rejects.toThrow('Run `wrangler login` or set CLOUDFLARE_API_TOKEN.');
  });
});

describe('--write confirmation (T7)', () => {
  const dir = () => project(withBinding({ binding: 'DB', database_id: FAKE_TARGET.databaseId }));

  test('a TTY must type the database name', async () => {
    const printed: string[] = [];
    const confirm = vi.fn(async () => 'fake-db');
    const opened = await openRemote(
      options('--write'),
      deps(dir(), { tty: true, confirm, print: (t) => printed.push(t) }),
    );
    expect(opened.driver.readOnly).toBe(false);
    expect(confirm).toHaveBeenCalledWith('Type the database name to continue:');
    const warning = printed.join('\n');
    expect(warning).toContain('Write access to REMOTE database');
    expect(warning).toContain('account   Fake Co (acc-…)');
    expect(warning).toContain('database  fake-db (db-f…)');
  });

  test.each([
    ['a mismatch', async () => 'prod-db', '"prod-db" isn\'t "fake-db". Not starting.'],
    ['a cancel', async () => undefined, 'Cancelled.'],
  ])('%s exits 1', async (_, confirm, message) => {
    const err = await openRemote(options('--write'), deps(dir(), { tty: true, confirm })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UserError);
    expect(err).toMatchObject({ message });
  });

  test('no TTY needs --yes', async () => {
    const confirm = vi.fn();
    await expect(openRemote(options('--write'), deps(dir(), { confirm }))).rejects.toThrow(
      new UserError(NEEDS_YES),
    );
    const opened = await openRemote(options('--write', '--yes'), deps(dir(), { confirm }));
    expect(opened.driver.readOnly).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  test('read-only never asks', async () => {
    const confirm = vi.fn();
    await openRemote(options(), deps(dir(), { tty: true, confirm }));
    expect(confirm).not.toHaveBeenCalled();
  });
});

test('confirmRemoteWrite without an account name shows the id', async () => {
  const printed: string[] = [];
  await confirmRemoteWrite(
    { account: { id: FAKE_ACCOUNT.id }, database: { id: '3f2a9c1e', name: 'prod-db' } },
    { tty: false, yes: true, print: (t) => printed.push(t) },
  );
  expect(printed.join('\n')).toContain(`account   ${FAKE_ACCOUNT.id}`);
});
