import type { Cell, ParamValue } from "../shared/values";

export interface Stmt {
  sql: string;
  params?: ParamValue[];
  /**
   * The rows this statement must change. A driver that can abort a batch
   * inside its transaction does so with a `ConflictError`; one that can't
   * (remote) leaves the check to the caller, which reads `changes`.
   */
  expectChanges?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  changes?: number;
  lastRowId?: Cell;
  /** Engine time; for remote, D1's SQL time without the network. */
  durationMs: number;
  /** Remote only: what D1 bills for. */
  rowsRead?: number;
  rowsWritten?: number;
}

/** Rows read and written so far in this session (remote only). */
export interface Usage {
  rowsRead: number;
  rowsWritten: number;
}

/**
 * One database, local or remote. Drivers implement only `query` and `batch`;
 * introspection is shared (see `introspect.ts`).
 */
export interface Driver {
  readonly mode: "local" | "remote";
  readonly readOnly: boolean;
  /** Session totals; remote only, since D1 bills per row. */
  readonly usage?: Usage;
  /** Runs each statement in `sql` in order; one result per statement. */
  query(sql: string, params?: ParamValue[]): Promise<QueryResult[]>;
  /** Runs single statements in one transaction; all or nothing. */
  batch(stmts: Stmt[]): Promise<QueryResult[]>;
  close(): Promise<void>;
}

/**
 * An error from the database engine. `message` is the engine's text, shown
 * to the user verbatim (UI-8).
 */
export class DbError extends Error {
  override name = "DbError";
  constructor(
    message: string,
    readonly statementIndex?: number,
  ) {
    super(message);
  }
}

/** A batch statement failed; nothing was committed. */
export class BatchError extends DbError {
  override name = "BatchError";
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(message, index);
  }
}

/**
 * A statement with `expectChanges` changed another number of rows, so the
 * row was changed or deleted since it was loaded. The batch was rolled back.
 */
export class ConflictError extends BatchError {
  override name = "ConflictError";
  constructor(
    index: number,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(index, `Statement ${index + 1} changed ${actual} rows, expected ${expected}.`);
  }
}
