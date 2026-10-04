import type { ParamValue } from './values';

/** A value the grid can write. BLOBs aren't editable in v1. */
export type CellValue = null | number | string | { $int: string };

/**
 * Identifies the row an edit targets: its `rowid` (a string when past 2^53),
 * or the values of its primary key.
 */
export type RowKey =
  | { kind: 'rowid'; rowid: number | string }
  | { kind: 'pk'; values: Record<string, CellValue> };

/** One staged change. Columns left out of an insert take their DEFAULT. */
export type EditOp =
  | { op: 'update'; key: RowKey; set: Record<string, CellValue> }
  | { op: 'insert'; values: Record<string, CellValue> }
  | { op: 'delete'; key: RowKey };

/** The most ops one batch may carry. */
export const MAX_OPS = 1000;

/**
 * What a write needs before it runs (D12): nothing in local mode; a click in
 * remote write mode; the typed database name for destructive SQL.
 */
export type ConfirmLevel = 'none' | 'click' | 'type-name';

/** `true` for a click; the database name for `type-name`. */
export type Confirm = true | string;

export interface PreviewStatement {
  sql: string;
  /** Bound at run time; the preview shows them inlined. */
  params: ParamValue[];
  /** `DROP`, `ALTER … DROP`, or `UPDATE`/`DELETE` without `WHERE` (01-T6). */
  dangerous: boolean;
}

/** The exact SQL a write will run. Also the body of a 409 `confirmation_required`. */
export interface WritePreview {
  statements: PreviewStatement[];
  dangerous: boolean;
  requiresConfirm: ConfirmLevel;
}

export interface BatchRequest {
  table: string;
  ops: EditOp[];
  confirm?: Confirm;
}

/** An update or delete that matched no row, on a driver that can't roll back for it. */
export interface BatchWarning {
  opIndex: number;
  message: string;
}

export interface BatchResponse {
  statements: number;
  inserted: number;
  updated: number;
  deleted: number;
  warnings: BatchWarning[];
  /** Server-measured, including the network round trip in remote mode. */
  elapsedMs: number;
}
