import { type ArgsDef, parseArgs, renderUsage } from 'citty';

import { UserError } from '../errors';

/** A bad command line. */
export class UsageError extends UserError {
  override name = 'UsageError';
}

export const argsDef = {
  path: {
    type: 'positional',
    required: false,
    valueHint: 'path',
    description: 'SQLite file to open with --local (skips config discovery)',
  },
  local: { type: 'boolean', description: 'Open the local Miniflare SQLite file (default)' },
  remote: { type: 'boolean', description: 'Connect to deployed D1 via the Cloudflare REST API' },
  port: {
    type: 'string',
    alias: 'p',
    valueHint: 'n',
    description: 'Port for the studio server (default 4101, or D1_STUDIO_PORT)',
  },
  host: {
    type: 'string',
    valueHint: 'addr',
    default: '127.0.0.1',
    description: 'Bind address',
  },
  db: { type: 'string', valueHint: 'name', description: 'Binding or database name to open' },
  config: {
    type: 'string',
    valueHint: 'path',
    description: 'Path to wrangler.json, wrangler.jsonc or wrangler.toml',
  },
  env: {
    type: 'string',
    valueHint: 'name',
    description: 'Wrangler environment to read bindings from',
  },
  'persist-to': {
    type: 'string',
    valueHint: 'dir',
    description: "Local state dir, like Wrangler's flag (default .wrangler/state)",
  },
  write: {
    type: 'boolean',
    description: 'Allow edits (on for local, off for remote)',
    negativeDescription: 'Open read-only',
  },
  open: {
    type: 'boolean',
    default: true,
    description: 'Open the browser',
    negativeDescription: "Don't launch the browser",
  },
  yes: {
    type: 'boolean',
    alias: 'y',
    description: 'Skip the remote --write confirmation (for non-interactive runs)',
  },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
  version: { type: 'boolean', alias: 'v', description: 'Show the version' },
} satisfies ArgsDef;

export interface CliOptions {
  mode: 'local' | 'remote';
  /** Positional SQLite path; skips discovery. */
  path?: string;
  /** Raw `--port` value; validated by `resolvePort`. */
  port?: string;
  host: string;
  db?: string;
  config?: string;
  env?: string;
  persistTo?: string;
  write: boolean;
  open: boolean;
  yes: boolean;
}

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; options: CliOptions };

const STRING_FLAGS = ['port', 'host', 'db', 'config', 'env', 'persist-to'] as const;

const knownFlags = new Set<string>(['_']);
for (const [name, def] of Object.entries(argsDef)) {
  knownFlags.add(name);
  // citty also sets the camelCase key (`persistTo`).
  knownFlags.add(name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()));
  const alias = 'alias' in def ? def.alias : undefined;
  if (alias) knownFlags.add(alias);
}

export function parseCli(argv: string[]): ParsedCommand {
  const args = parseArgs(argv, argsDef) as Record<string, unknown> & { _: string[] };

  if (args.help) return { kind: 'help' };
  if (args.version) return { kind: 'version' };

  for (const key of Object.keys(args)) {
    if (!knownFlags.has(key)) {
      throw new UsageError(`Unknown option --${key}.`);
    }
  }
  if (args._.length > 1) {
    throw new UsageError(`Expected at most one database path, got ${args._.length}.`);
  }
  for (const name of STRING_FLAGS) {
    const value = args[name];
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      throw new UsageError(`--${name} needs a value.`);
    }
  }

  const local = args.local === true;
  const remote = args.remote === true;
  if (local && remote) {
    throw new UsageError('--local and --remote are mutually exclusive.');
  }
  const mode = remote ? 'remote' : 'local';
  const path = args._[0];
  if (path !== undefined && mode === 'remote') {
    throw new UsageError("A database path can't be used with --remote.");
  }

  const str = (name: (typeof STRING_FLAGS)[number]) => args[name] as string | undefined;
  return {
    kind: 'run',
    options: {
      mode,
      path,
      port: str('port'),
      host: str('host') ?? '127.0.0.1',
      db: str('db'),
      config: str('config'),
      env: str('env'),
      persistTo: str('persist-to'),
      write: typeof args.write === 'boolean' ? args.write : mode === 'local',
      open: args.open !== false,
      yes: args.yes === true,
    },
  };
}

export function renderHelp(): Promise<string> {
  return renderUsage({
    meta: {
      name: 'd1-studio',
      version: __VERSION__,
      description: 'Open a browser studio for your Cloudflare D1 database',
    },
    args: argsDef,
  });
}
