import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

import { UserError } from '../errors';
import { displayPath } from '../paths';

/** Wrangler's own order (D3). */
export const CONFIG_NAMES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'] as const;
export const DEPLOY_REDIRECT = path.join('.wrangler', 'deploy', 'config.json');

export interface FoundConfig {
  /** The config to read bindings from (the redirect target when redirected). */
  path: string;
  /**
   * The user's own config, before any redirect. Wrangler resolves the default
   * `.wrangler/state` relative to this file's directory.
   */
  userConfigPath?: string;
  redirected: boolean;
}

/**
 * Finds the Wrangler config. With `explicit` (`--config`), uses that path.
 * Otherwise walks up from `cwd`, checking each directory for a deploy redirect
 * and then `wrangler.json`, `wrangler.jsonc`, `wrangler.toml`. The walk stops
 * after the first directory containing `.git`, or at the filesystem root.
 * Returns `undefined` when nothing is found.
 */
export function findConfig(cwd: string, explicit?: string): FoundConfig | undefined {
  if (explicit !== undefined) {
    const file = path.resolve(cwd, explicit);
    if (!isFile(file)) {
      throw new UserError(`Config file not found: ${displayPath(file, cwd)}`);
    }
    return { path: file, userConfigPath: file, redirected: false };
  }

  let dir = path.resolve(cwd);
  for (;;) {
    const userConfigPath = CONFIG_NAMES.map((name) => path.join(dir, name)).find(isFile);
    const redirect = path.join(dir, DEPLOY_REDIRECT);
    // A redirect wins over a user config in the same directory, as in Wrangler.
    if (isFile(redirect)) {
      return { path: readRedirect(redirect, cwd), userConfigPath, redirected: true };
    }
    if (userConfigPath) return { path: userConfigPath, userConfigPath, redirected: false };

    const parent = path.dirname(dir);
    if (existsSync(path.join(dir, '.git')) || parent === dir) return undefined;
    dir = parent;
  }
}

function readRedirect(file: string, cwd: string): string {
  const errors: ParseError[] = [];
  const data = parseJsonc(readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
  const configPath = (data as { configPath?: unknown } | undefined)?.configPath;
  if (errors.length > 0 || typeof configPath !== 'string' || configPath === '') {
    const why = errors[0] ? printParseErrorCode(errors[0].error) : 'no "configPath"';
    throw new UserError(`Invalid deploy redirect ${displayPath(file, cwd)}: ${why}.`);
  }
  const target = path.resolve(path.dirname(file), configPath);
  if (!isFile(target)) {
    throw new UserError(
      `Deploy redirect ${displayPath(file, cwd)} points to ${displayPath(target, cwd)}, which doesn't exist.`,
    );
  }
  return target;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
