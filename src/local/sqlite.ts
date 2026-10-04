/**
 * A thin synchronous SQLite connection over `node:sqlite` (Node) or
 * `bun:sqlite` (Bun). Rows are arrays; integers come back as `bigint`.
 */
export interface SqliteConn {
  prepare(sql: string): PreparedStatement;
  /** Runs SQL with no parameters or results (`BEGIN`, `COMMIT`, pragmas). */
  exec(sql: string): void;
  close(): void;
}

export interface PreparedStatement {
  /** Result column names; empty for statements that return no rows. */
  readonly columns: string[];
  all(params: unknown[]): unknown[][];
  run(params: unknown[]): { changes: number; lastRowId: number | bigint };
}

export interface OpenOptions {
  readOnly: boolean;
}

/** The file belongs to workerd and is already WAL; we never touch `journal_mode`. */
const BUSY_TIMEOUT_MS = 5000;

export async function openSqlite(path: string, { readOnly }: OpenOptions): Promise<SqliteConn> {
  const conn = process.versions.bun
    ? await openBun(path, readOnly)
    : await openNode(path, readOnly);
  try {
    conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (err) {
    conn.close();
    throw err;
  }
  return conn;
}

async function openNode(path: string, readOnly: boolean): Promise<SqliteConn> {
  silenceSqliteExperimentalWarning();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly });
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      // Per-statement setters: the constructor options need Node > 22.16 (S4).
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      return {
        columns: stmt.columns().map((c) => c.name),
        all: (params) => stmt.all(...(params as never[])) as unknown as unknown[][],
        run: (params) => {
          const { changes, lastInsertRowid } = stmt.run(...(params as never[]));
          return { changes: Number(changes), lastRowId: lastInsertRowid };
        },
      };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

async function openBun(path: string, readOnly: boolean): Promise<SqliteConn> {
  const { Database } = await import('bun:sqlite');
  const db = readOnly
    ? openBunReadOnly(Database, path)
    : new Database(path, { readwrite: true, create: false, safeIntegers: true });
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        columns: stmt.columnNames,
        all: (params) => stmt.values(...params),
        run: (params) => {
          const { changes, lastInsertRowid } = stmt.run(...params);
          return { changes: Number(changes), lastRowId: lastInsertRowid };
        },
      };
    },
    exec: (sql) => {
      db.run(sql);
    },
    close: () => db.close(),
  };
}

type BunDatabase = typeof import('bun:sqlite').Database;
const PROBE = 'SELECT 1 FROM sqlite_schema LIMIT 1';

/**
 * bun:sqlite can't read a WAL database read-only while its `-wal`/`-shm`
 * files are missing (SQLITE_CANTOPEN), which happens after a clean close. A
 * short-lived read-write handle creates them; the read-only handle opens and
 * maps them before that handle closes, so they stay.
 */
function openBunReadOnly(Database: BunDatabase, path: string) {
  const openProbed = () => {
    const ro = new Database(path, { readonly: true, safeIntegers: true });
    try {
      ro.prepare(PROBE).values();
      return ro;
    } catch (err) {
      ro.close();
      throw err;
    }
  };
  try {
    return openProbed();
  } catch (err) {
    if ((err as { code?: string }).code !== 'SQLITE_CANTOPEN') throw err;
  }
  const rw = new Database(path, { readwrite: true, create: false });
  try {
    rw.prepare(PROBE).values();
    return openProbed();
  } finally {
    rw.close();
  }
}

let warningFilterInstalled = false;

/** Drops only node:sqlite's ExperimentalWarning; everything else still prints. */
function silenceSqliteExperimentalWarning() {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  // oxlint-disable-next-line typescript/unbound-method -- called with `process` as `this` below.
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const [options] = rest;
    const type =
      typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type;
    const message = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && message.includes('SQLite')) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
}
