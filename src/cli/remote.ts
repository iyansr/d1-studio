import { findConfig } from '../config/find';
import { type D1Binding, parseConfig } from '../config/parse';
import { pickBinding, selectBindings } from '../config/select';
import { RemoteDriver } from '../drivers/remote';
import { UserError } from '../errors';
import { displayPath } from '../paths';
import { D1ApiError, D1Client, type D1Database } from '../remote/client';
import {
  type Credentials,
  explainAuthError,
  type ResolveOptions,
  resolveCredentials,
} from '../remote/credentials';
import { type AccountMeta, type DatabaseMeta, readySession, type Session } from '../server/context';
import type { CliOptions } from './args';
import { confirmRemoteWrite, shortId, type TextPrompt } from './confirm';

export type SelectDatabase = (databases: D1Database[]) => Promise<D1Database>;

export interface RemoteDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  tty: boolean;
  fetch?: typeof fetch;
  run?: ResolveOptions['run'];
  findWrangler?: ResolveOptions['findWrangler'];
  selectAccount?: ResolveOptions['selectAccount'];
  selectDatabase?: SelectDatabase;
  confirm?: TextPrompt;
  print?: (text: string) => void;
}

export interface OpenedRemote {
  session: Session;
  driver: RemoteDriver;
  /** The banner's `database` line. */
  database: string;
  source?: { label: 'config'; value: string };
  /** The banner's `account` line. */
  account: string;
  accountMeta: AccountMeta;
}

interface Target {
  id: string;
  name: string;
  binding: string | null;
}

/**
 * Remote startup: credentials, then the database (from the config's bindings
 * or the account's list, T8), then the `--write` confirmation (T7).
 */
export async function openRemote(options: CliOptions, deps: RemoteDeps): Promise<OpenedRemote> {
  const readOnly = !options.write;
  const found = findConfig(deps.cwd, options.config);
  const config = found ? parseConfig(found.path) : undefined;
  const bindings = config ? selectBindings(config, options.env) : [];

  const creds = await resolveCredentials({
    env: deps.env,
    cwd: deps.cwd,
    projectDir: config?.dir,
    configAccountId: config?.accountId,
    tty: deps.tty,
    fetch: deps.fetch,
    run: deps.run,
    findWrangler: deps.findWrangler,
    selectAccount: deps.selectAccount,
  });
  const client = new D1Client({ token: creds.token, fetch: deps.fetch });
  const where = config
    ? `${displayPath(config.path, deps.cwd)}${options.env ? ` [env.${options.env}]` : ''}`
    : undefined;

  const target =
    bindings.length > 0
      ? await fromBindings(client, creds, bindings, options.db, { tty: deps.tty, where })
      : await fromAccount(client, creds, options.db, deps);

  let accountLabel = creds.accountName;
  if (!readOnly) {
    // Best effort, and only when writing: it is one more API call.
    accountLabel ??= await accountName(client, creds);
    await confirmRemoteWrite(
      { account: { id: creds.accountId, name: accountLabel }, database: target },
      { tty: deps.tty, yes: options.yes, prompt: deps.confirm, print: deps.print },
    );
  }

  const driver = new RemoteDriver(
    client,
    { accountId: creds.accountId, databaseId: target.id },
    readOnly,
  );
  const database: DatabaseMeta = { name: target.name, binding: target.binding, id: target.id };
  const parts = [target.binding && `binding ${target.binding}`, `id ${shortId(target.id)}`];
  const via = creds.source === 'env' ? 'CLOUDFLARE_API_TOKEN' : 'wrangler login';
  return {
    session: readySession(driver, database),
    driver,
    database: `${target.name} (${parts.filter(Boolean).join(', ')})`,
    source: found && {
      label: 'config',
      value: `${displayPath(found.path, deps.cwd)}${found.redirected ? ' (redirected)' : ''}`,
    },
    account: `${creds.accountName ? `${creds.accountName} (${shortId(creds.accountId)})` : creds.accountId}, via ${via}`,
    accountMeta: { id: creds.accountId, name: accountLabel ?? null },
  };
}

/** A binding from the config; `--db` not in it falls back to a lookup by name (T8). */
async function fromBindings(
  client: D1Client,
  creds: Credentials,
  bindings: D1Binding[],
  db: string | undefined,
  options: { tty: boolean; where?: string },
): Promise<Target> {
  const inConfig =
    db === undefined || bindings.some((b) => b.binding === db || b.databaseName === db);
  if (!inConfig) {
    const match = await findByName(client, creds, db);
    if (match) return { id: match.uuid, name: match.name, binding: null };
    const names = bindings.map((b) => b.binding).join(', ');
    throw new UserError(
      `No D1 binding or database named "${db}" in ${options.where ?? 'the config'} (${names}), nor in the account.`,
    );
  }
  const binding = await pickBinding(bindings, db, { tty: options.tty, source: options.where });
  if (binding.databaseId) {
    // Remote uses database_id, never preview_database_id.
    const remote = await probe(client, creds, binding.databaseId);
    return { id: remote.uuid, name: remote.name, binding: binding.binding };
  }
  const match = binding.databaseName
    ? await findByName(client, creds, binding.databaseName)
    : undefined;
  if (!match) {
    throw new UserError(
      `Binding ${binding.binding} has no database_id${binding.databaseName ? `, and no database named "${binding.databaseName}" is in the account` : ''}. ` +
        'Add database_id to the Wrangler config, or pass --db <name>.',
    );
  }
  return { id: match.uuid, name: match.name, binding: binding.binding };
}

/** No config (or no D1 in it): pick from the account's databases (T8). */
async function fromAccount(
  client: D1Client,
  creds: Credentials,
  db: string | undefined,
  deps: RemoteDeps,
): Promise<Target> {
  const databases = await list(client, creds);
  if (databases.length === 0) {
    throw new UserError('This Cloudflare account has no D1 databases.');
  }
  if (db !== undefined) {
    const match = databases.find((d) => d.name === db) ?? databases.find((d) => d.uuid === db);
    if (!match) {
      throw new UserError(`No D1 database named "${db}" in this account. ${available(databases)}`);
    }
    return { id: match.uuid, name: match.name, binding: null };
  }
  const [only] = databases;
  if (only && databases.length === 1) return { id: only.uuid, name: only.name, binding: null };
  if (!deps.tty) {
    throw new UserError(`Pass --db <name> to pick a D1 database. ${available(databases)}`);
  }
  const picked = await (deps.selectDatabase ?? clackSelectDatabase)(databases);
  return { id: picked.uuid, name: picked.name, binding: null };
}

function available(databases: D1Database[]): string {
  return `Available: ${databases.map((d) => d.name).join(', ')}.`;
}

async function findByName(
  client: D1Client,
  creds: Credentials,
  name: string,
): Promise<D1Database | undefined> {
  return (await list(client, creds)).find((d) => d.name === name);
}

async function list(client: D1Client, creds: Credentials): Promise<D1Database[]> {
  try {
    return await client.listDatabases(creds.accountId);
  } catch (err) {
    throw explainAuthError(err);
  }
}

/** The first D1 call: proves the token can read this database. */
async function probe(client: D1Client, creds: Credentials, id: string): Promise<D1Database> {
  try {
    return await client.getDatabase(creds.accountId, id);
  } catch (err) {
    if (err instanceof D1ApiError && err.status === 404) {
      throw new UserError(
        `No D1 database ${id} in account ${creds.accountId}. Check database_id and the account.`,
      );
    }
    throw explainAuthError(err);
  }
}

/** Best effort: a D1-only token may not be allowed to read account details. */
async function accountName(client: D1Client, creds: Credentials): Promise<string | undefined> {
  if (creds.accountName) return creds.accountName;
  try {
    return (await client.listAccounts()).find((a) => a.id === creds.accountId)?.name;
  } catch {
    return undefined;
  }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const clackSelectDatabase: SelectDatabase = async (databases) => {
  const { isCancel, select } = await import('@clack/prompts');
  const choice = await select({
    message: 'Which D1 database?',
    options: databases.map((d, i) => {
      const created = d.created_at ? Date.parse(d.created_at) : Number.NaN;
      const hint = [
        shortId(d.uuid),
        !Number.isNaN(created) && `created ${dateFormat.format(created)}`,
      ]
        .filter(Boolean)
        .join(' · ');
      return { value: i, label: d.name, hint };
    }),
  });
  if (isCancel(choice)) throw new UserError('Cancelled.');
  const picked = databases[choice];
  if (!picked) throw new UserError('Cancelled.');
  return picked;
};
