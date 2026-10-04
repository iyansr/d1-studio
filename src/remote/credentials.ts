import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { UserError } from '../errors';
import { type Account, D1ApiError, D1Client, NO_D1_ACCESS } from './client';
import { Secret } from './secret';

export type CredentialSource = 'env' | 'wrangler';

export interface Credentials {
  token: Secret;
  accountId: string;
  /** Known when the account came from the accounts API. */
  accountName?: string;
  source: CredentialSource;
}

/** A way to run Wrangler: `file` with `args` before `auth token --json`. */
export interface WranglerCommand {
  file: string;
  args: string[];
}

export interface RunResult {
  /** The executable doesn't exist. */
  notFound?: boolean;
  timedOut?: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunFile = (command: WranglerCommand, cwd: string) => Promise<RunResult>;
export type SelectAccount = (accounts: Account[]) => Promise<Account>;

export interface ResolveOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The Wrangler config's directory, searched first for the project's Wrangler. */
  projectDir?: string;
  /** `account_id` from the Wrangler config. */
  configAccountId?: string;
  tty: boolean;
  fetch?: typeof fetch;
  run?: RunFile;
  findWrangler?: (dirs: string[]) => WranglerCommand[];
  selectAccount?: SelectAccount;
}

export const NO_CREDENTIALS = 'Run `wrangler login` or set CLOUDFLARE_API_TOKEN.';
const TIMEOUT_MS = 10_000;

/**
 * The token and account for remote mode (PRD 3b, D2): `CLOUDFLARE_API_TOKEN`,
 * else the project's Wrangler via `wrangler auth token --json`; then the
 * account from `CLOUDFLARE_ACCOUNT_ID`, the config, or the accounts API.
 */
export async function resolveCredentials(options: ResolveOptions): Promise<Credentials> {
  const { token, source } = await resolveToken(options);
  const account = await resolveAccount(token, options);
  return { token, source, accountId: account.id, accountName: account.name };
}

async function resolveToken(
  options: ResolveOptions,
): Promise<{ token: Secret; source: CredentialSource }> {
  const fromEnv = options.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) return { token: new Secret(fromEnv), source: 'env' };

  const dirs = [...new Set([options.projectDir, options.cwd].filter((d) => d !== undefined))];
  const commands = (options.findWrangler ?? findWrangler)(dirs);
  const run = options.run ?? runWrangler;
  let hint = "Wrangler isn't installed in this project or on PATH.";
  for (const command of commands) {
    const result = await run(command, options.projectDir ?? options.cwd);
    if (result.notFound) continue;
    const parsed = parseAuthToken(result);
    if (parsed.ok) return { token: new Secret(parsed.token), source: 'wrangler' };
    // The first Wrangler that runs decides; another would share its login.
    hint = HINTS[parsed.reason];
    break;
  }
  throw new UserError(hint ? `${NO_CREDENTIALS}\n${hint}` : NO_CREDENTIALS);
}

const HINTS: Record<TokenFailure, string> = {
  'not-logged-in': '',
  'api-key':
    "Wrangler is using CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL, which d1-studio doesn't support.",
  outdated:
    'This Wrangler has no `wrangler auth token` command. Upgrade it, e.g. `npm i -D wrangler@latest`.',
  timeout: `\`wrangler auth token\` didn't finish within ${TIMEOUT_MS / 1000} s.`,
  unrecognised: "`wrangler auth token` printed something d1-studio doesn't recognise.",
};

type TokenFailure = 'not-logged-in' | 'api-key' | 'outdated' | 'timeout' | 'unrecognised';

export type TokenResult = { ok: true; token: string } | { ok: false; reason: TokenFailure };

/**
 * Reads `wrangler auth token --json` output (S2). Never echo `stdout`: it
 * may hold the token.
 */
export function parseAuthToken(result: RunResult): TokenResult {
  if (result.timedOut) return { ok: false, reason: 'timeout' };
  if (result.code !== 0) {
    const output = `${result.stderr}\n${result.stdout}`;
    if (/not logged in/i.test(output)) return { ok: false, reason: 'not-logged-in' };
    if (/unknown (?:argument|command)/i.test(output)) return { ok: false, reason: 'outdated' };
    return { ok: false, reason: 'unrecognised' };
  }
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end < start) return { ok: false, reason: 'unrecognised' };
  let data: unknown;
  try {
    data = JSON.parse(result.stdout.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'unrecognised' };
  }
  const { type, token } = (data ?? {}) as { type?: unknown; token?: unknown };
  if (type === 'api_key') return { ok: false, reason: 'api-key' };
  if ((type === 'oauth' || type === 'api_token') && typeof token === 'string' && token.trim()) {
    return { ok: true, token: token.trim() };
  }
  return { ok: false, reason: 'unrecognised' };
}

async function resolveAccount(
  token: Secret,
  options: ResolveOptions,
): Promise<{ id: string; name?: string }> {
  const fromEnv = options.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv) return { id: fromEnv };
  if (options.configAccountId) return { id: options.configAccountId };

  let accounts: Account[];
  try {
    accounts = await new D1Client({ token, fetch: options.fetch }).listAccounts();
  } catch (err) {
    throw new UserError(
      `Couldn't list your Cloudflare accounts: ${explainAuthError(err).message}\n` +
        'Set CLOUDFLARE_ACCOUNT_ID, or account_id in the Wrangler config.',
    );
  }
  const [only] = accounts;
  if (!only) {
    throw new UserError("The token can't see any Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID.");
  }
  if (accounts.length === 1) return only;
  if (!options.tty) {
    const list = accounts.map((a) => `  ${a.name} (${a.id})`).join('\n');
    throw new UserError(
      `The token can see several Cloudflare accounts:\n${list}\nSet CLOUDFLARE_ACCOUNT_ID.`,
    );
  }
  return (options.selectAccount ?? clackSelectAccount)(accounts);
}

const clackSelectAccount: SelectAccount = async (accounts) => {
  const { isCancel, select } = await import('@clack/prompts');
  const choice = await select({
    message: 'Which Cloudflare account?',
    options: accounts.map((a, i) => ({ value: i, label: a.name, hint: a.id })),
  });
  if (isCancel(choice)) throw new UserError('Cancelled.');
  const picked = accounts[choice];
  if (!picked) throw new UserError('Cancelled.');
  return picked;
};

/** A clearer error for a rejected token; anything else passes through. */
export function explainAuthError(err: unknown): Error {
  if (err instanceof D1ApiError && err.status === 401) {
    return new UserError(
      `Cloudflare didn't accept the token (${err.message}). Run \`wrangler login\` again or check CLOUDFLARE_API_TOKEN.`,
    );
  }
  if (err instanceof D1ApiError && err.status === 403) return new UserError(NO_D1_ACCESS);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Wrangler installs to try, in order: the project's own (walking up from each
 * dir to the git root), then a global one. Each runs its package's `bin`
 * script with this runtime, so Windows `.cmd` shims (which need a shell) are
 * never involved. Never `npx`: it may install from the network.
 */
export function findWrangler(dirs: string[]): WranglerCommand[] {
  const commands: WranglerCommand[] = [];
  const seen = new Set<string>();
  const add = (pkgDir: string) => {
    const bin = binScript(pkgDir);
    if (bin && !seen.has(bin)) {
      seen.add(bin);
      commands.push({ file: process.execPath, args: [bin] });
    }
  };
  for (const start of dirs) {
    let dir = path.resolve(start);
    for (;;) {
      add(path.join(dir, 'node_modules', 'wrangler'));
      const parent = path.dirname(dir);
      if (existsSync(path.join(dir, '.git')) || parent === dir) break;
      dir = parent;
    }
  }
  if (process.platform === 'win32') {
    // npm's global layout: %APPDATA%\npm\wrangler.cmd next to node_modules\wrangler.
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      add(path.join(dir, 'node_modules', 'wrangler'));
    }
  } else {
    commands.push({ file: 'wrangler', args: [] });
  }
  return commands;
}

function binScript(pkgDir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler;
    return bin ? path.resolve(pkgDir, bin) : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `<wrangler> auth token --json`: no shell, no stdin, 10 s timeout. */
export const runWrangler: RunFile = (command, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command.file, [...command.args, 'auth', 'token', '--json'], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      windowsHide: true,
      // No telemetry event for our lookup, and no colour codes in the output.
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ notFound: err.code === 'ENOENT', code: null, stdout: '', stderr: '' });
    });
    child.on('close', (code, signal) => {
      resolve({ code, stdout, stderr, timedOut: code === null && signal === 'SIGTERM' });
    });
  });
