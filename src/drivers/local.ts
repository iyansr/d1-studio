import { openSqlite, type SqliteConn } from "../local/sqlite";
import { type Cell, decodeParam, encodeValue, type ParamValue } from "../shared/values";
import { splitStatements } from "../sql/split";
import { BatchError, DbError, type Driver, type QueryResult, type Stmt } from "./types";

/** A Miniflare (or any) SQLite file opened in-process. */
export class LocalDriver implements Driver {
  readonly mode = "local";

  private constructor(
    private readonly conn: SqliteConn,
    /** Mirrors `--write`; the file is then also opened read-only. */
    readonly readOnly: boolean,
  ) {}

  static async open(path: string, options: { readOnly: boolean }): Promise<LocalDriver> {
    return new LocalDriver(await openSqlite(path, options), options.readOnly);
  }

  async query(sql: string, params: ParamValue[] = []): Promise<QueryResult[]> {
    const statements = splitStatements(sql);
    if (params.length > 0 && statements.length > 1) {
      throw new DbError("Parameters can only be used with a single statement.");
    }
    return statements.map((stmt, i) => {
      try {
        return this.execute(stmt.sql, params);
      } catch (err) {
        throw new DbError(messageOf(err), i);
      }
    });
  }

  async batch(stmts: Stmt[]): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    this.conn.exec("BEGIN IMMEDIATE");
    try {
      stmts.forEach((stmt, i) => {
        try {
          if (splitStatements(stmt.sql).length !== 1) {
            throw new Error("Each batch entry must be exactly one statement.");
          }
          results.push(this.execute(stmt.sql, stmt.params ?? []));
        } catch (err) {
          throw new BatchError(i, messageOf(err));
        }
      });
      this.conn.exec("COMMIT");
    } catch (err) {
      try {
        this.conn.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back (e.g. after SQLITE_FULL).
      }
      throw err;
    }
    return results;
  }

  async close(): Promise<void> {
    this.conn.close();
  }

  private execute(sql: string, params: ParamValue[]): QueryResult {
    const started = performance.now();
    const stmt = this.conn.prepare(sql);
    const bound = params.map(decodeParam);
    if (stmt.columns.length > 0) {
      const rows = stmt.all(bound).map((row) => row.map(encodeValue));
      return { columns: stmt.columns, rows, durationMs: elapsed(started) };
    }
    const { changes, lastRowId } = stmt.run(bound);
    return {
      columns: [],
      rows: [] as Cell[][],
      changes,
      lastRowId: encodeValue(lastRowId),
      durationMs: elapsed(started),
    };
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
