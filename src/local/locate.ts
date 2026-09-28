import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { D1Binding } from "../config/parse";
import { UserError } from "../errors";
import { displayPath } from "../paths";
import { isHiddenTable } from "../shared/tables";
import { quoteIdent } from "../sql/ident";
import { localD1FileName } from "./filename";
import { openSqlite } from "./sqlite";

export const D1_STATE_SUBDIR = path.join("v3", "d1", "miniflare-D1DatabaseObject");
/** Row counts are shown for at most this many tables per candidate file. */
const COUNTED_TABLES = 5;

/**
 * Wrangler's rule: `--persist-to` is relative to cwd; the default
 * `.wrangler/state` is relative to the user's config file, else cwd.
 */
export function resolvePersistDir(options: {
  cwd: string;
  persistTo?: string;
  userConfigPath?: string;
}): string {
  if (options.persistTo) return path.resolve(options.cwd, options.persistTo);
  const base = options.userConfigPath ? path.dirname(options.userConfigPath) : options.cwd;
  return path.resolve(base, ".wrangler", "state");
}

export function d1StateDir(persistDir: string): string {
  return path.join(persistDir, D1_STATE_SUBDIR);
}

/**
 * The derived file for `binding`. Wrangler names the Durable Object after
 * `preview_database_id ?? database_id ?? binding` (D4), so try each in turn.
 */
export function locateLocalDb(binding: D1Binding, dir: string): string | undefined {
  const ids = [binding.previewDatabaseId, binding.databaseId, binding.binding];
  for (const id of ids) {
    if (!id) continue;
    const file = path.join(dir, localD1FileName(id));
    if (isFile(file)) return file;
  }
  return undefined;
}

export interface Candidate {
  /** Opaque index; the browser never sends a path. */
  id: number;
  fileName: string;
  mtime: string;
  size: number;
  tables: { name: string; rows: number | null }[];
  /** Set when the file couldn't be read. */
  error?: string;
}

export interface CandidateFile extends Candidate {
  /** Server-side only; never sent to the browser. */
  path: string;
}

/** Every `*.sqlite` file in `dir` except `metadata.sqlite`, newest first. */
export async function listCandidates(dir: string): Promise<CandidateFile[]> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = names
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => ({ name, file: path.join(dir, name), stat: statSync(path.join(dir, name)) }))
    .filter(({ stat }) => stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const candidates: CandidateFile[] = [];
  for (const [id, { name, file, stat }] of files.entries()) {
    const base = {
      id,
      path: file,
      fileName: name,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
    };
    try {
      candidates.push({ ...base, tables: await peekTables(file) });
    } catch (err) {
      candidates.push({ ...base, tables: [], error: (err as Error).message });
    }
  }
  return candidates;
}

/** User tables in `file`, with row counts for the first few. */
async function peekTables(file: string): Promise<Candidate["tables"]> {
  const conn = await openSqlite(file, { readOnly: true });
  try {
    const names = conn
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all([])
      .map((row) => String(row[0]))
      .filter((name) => !isHiddenTable(name));
    return names.map((name, i) => {
      if (i >= COUNTED_TABLES) return { name, rows: null };
      try {
        const [row] = conn.prepare(`SELECT count(*) FROM ${quoteIdent(name)}`).all([]);
        return { name, rows: Number(row?.[0]) };
      } catch {
        return { name, rows: null };
      }
    });
  } finally {
    conn.close();
  }
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

/** For a positional path: the file must exist and carry the SQLite header. */
export function assertSqliteFile(file: string): void {
  const shown = displayPath(file);
  if (!isFile(file)) throw new UserError(`No such file: ${shown}`);
  const header = Buffer.alloc(SQLITE_HEADER.length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (!header.equals(SQLITE_HEADER)) {
    throw new UserError(`${shown} is not a SQLite database.`);
  }
}

export const NO_LOCAL_DB_HINT =
  "Run `wrangler dev` or `wrangler d1 migrations apply --local` first.";

export type LocalTarget =
  | { kind: "file"; path: string }
  | { kind: "needs-db"; candidates: CandidateFile[] };

/**
 * A derived match opens directly. Otherwise, if any files exist, the studio
 * starts in needs-db state so the user can pick one. With nothing on disk,
 * the CLI stops.
 */
export async function resolveLocalTarget(binding: D1Binding, dir: string): Promise<LocalTarget> {
  const file = locateLocalDb(binding, dir);
  if (file) return { kind: "file", path: file };
  const candidates = await listCandidates(dir);
  if (candidates.length > 0) return { kind: "needs-db", candidates };
  throw new UserError(
    `No local D1 database found in ${displayPath(dir)}.\n${NO_LOCAL_DB_HINT}\n` +
      "If your dev script passes --persist-to to Wrangler, pass the same --persist-to here.",
  );
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
