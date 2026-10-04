import {
  D1ApiError,
  type D1Client,
  type D1RawResult,
  type D1Target,
  NO_D1_ACCESS,
} from '../remote/client';
import type { Cell, ParamValue } from '../shared/values';
import { classify, isReadKind } from '../sql/classify';
import { splitStatements } from '../sql/split';
import { BatchError, DbError, type Driver, type QueryResult, type Stmt, type Usage } from './types';

/** A deployed D1 database over the REST API's `raw` endpoint (S1). */
export class RemoteDriver implements Driver {
  readonly mode = 'remote';
  readonly usage: Usage = { rowsRead: 0, rowsWritten: 0 };

  constructor(
    private readonly client: D1Client,
    private readonly target: D1Target,
    /** Enforced by the server's classifier; D1 has no read-only connection. */
    readonly readOnly: boolean,
  ) {}

  async query(sql: string, params: ParamValue[] = []): Promise<QueryResult[]> {
    const statements = splitStatements(sql);
    if (statements.length === 0) return [];
    if (params.length > 0 && statements.length > 1) {
      throw new DbError('Parameters can only be used with a single statement.');
    }
    const retry = statements.every((s) => isReadKind(classify(s.tokens).kind));
    const stmt = params.length > 0 ? { sql, params: params.map(encodeParam) } : { sql };
    const results = await this.call(() => this.client.raw(this.target, stmt, { retry }));
    return results.map((r) => this.toResult(r));
  }

  async batch(stmts: Stmt[]): Promise<QueryResult[]> {
    const parsed = stmts.map((stmt, i) => {
      const statements = splitStatements(stmt.sql);
      if (statements.length !== 1) {
        throw new BatchError(i, 'Each batch entry must be exactly one statement.');
      }
      return statements[0] as (typeof statements)[number];
    });
    if (parsed.length === 0) return [];
    const retry = parsed.every((s) => isReadKind(classify(s.tokens).kind));
    const body = stmts.map((s) =>
      s.params?.length ? { sql: s.sql, params: s.params.map(encodeParam) } : { sql: s.sql },
    );
    // D1 runs a batch as one transaction but doesn't say which entry failed.
    const results = await this.call(() => this.client.batch(this.target, body, { retry }));
    return results.map((r) => this.toResult(r));
  }

  async close(): Promise<void> {}

  private async call(run: () => Promise<D1RawResult[]>): Promise<D1RawResult[]> {
    try {
      return await run();
    } catch (err) {
      throw toDriverError(err);
    }
  }

  private toResult(result: D1RawResult): QueryResult {
    const meta = result.meta ?? {};
    const rowsRead = meta.rows_read ?? 0;
    const rowsWritten = meta.rows_written ?? 0;
    this.usage.rowsRead += rowsRead;
    this.usage.rowsWritten += rowsWritten;
    const durationMs = round(meta.timings?.sql_duration_ms ?? meta.duration ?? 0);
    const columns = result.results?.columns ?? [];
    if (columns.length > 0) {
      const rows = (result.results?.rows ?? []).map((row) => row.map(decodeCell));
      return { columns, rows, durationMs, rowsRead, rowsWritten };
    }
    return {
      columns: [],
      rows: [],
      changes: meta.changes ?? 0,
      lastRowId: meta.last_row_id ?? null,
      durationMs,
      rowsRead,
      rowsWritten,
    };
  }
}

/**
 * SQL errors become `DbError` (shown verbatim, UI-8). A 403 gets the
 * permission hint. Anything else (auth, rate limit, outage) stays a
 * `D1ApiError` for the server to map.
 */
function toDriverError(err: unknown): unknown {
  if (!(err instanceof D1ApiError)) return err;
  if (err.status === 403) return new D1ApiError(NO_D1_ACCESS, 403, err.code);
  const client = err.status >= 400 && err.status < 500;
  const upstream = [401, 404, 408, 429].includes(err.status);
  if (err.status === 200 || (client && !upstream)) return new DbError(err.message);
  return err;
}

/**
 * JSON → the API. Numbers and null pass through; the API may bind them as
 * text (S1), which column affinity absorbs.
 */
export function encodeParam(value: ParamValue): null | number | string {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object' && typeof value.$int === 'string' && /^-?\d+$/.test(value.$int)) {
    return value.$int;
  }
  throw new DbError(`Unsupported parameter value: ${JSON.stringify(value)}`);
}

/** The API → `Cell`. BLOBs arrive as byte arrays; integers past 2^53 already lost precision. */
export function decodeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return { $blob: value.length };
  return JSON.stringify(value);
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
