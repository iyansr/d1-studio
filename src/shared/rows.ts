import type { Cell, ParamValue } from "./values";

/** Grid page sizes (UI-3). */
export const PAGE_SIZES = [50, 100, 500] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** Filter operators (UI-4). `null` and `nnull` take no value. */
export const FILTER_OPS = [
  "eq",
  "ne",
  "lt",
  "gt",
  "le",
  "ge",
  "like",
  "nlike",
  "null",
  "nnull",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const UNARY_OPS: ReadonlySet<FilterOp> = new Set(["null", "nnull"]);

export interface Filter {
  col: string;
  op: FilterOp;
  value?: ParamValue;
}

export interface Sort {
  col: string;
  dir: "asc" | "desc";
}

/**
 * Selected as the first column of a rowid table's page. It never collides
 * with a real column in practice; `key.columns` names it.
 */
export const ROWID_COLUMN = "__d1s_rowid";

/** The columns that identify a row of the page for edits (plan 04). */
export type RowsKey =
  | { kind: "rowid"; columns: [typeof ROWID_COLUMN] }
  | { kind: "pk"; columns: string[] }
  | { kind: "none"; columns: [] };

export interface RowsColumn {
  name: string;
  /** Declared type; empty when the column has none. */
  type: string;
  /** 1-based position in the primary key, or 0. */
  pk: number;
  fk?: { table: string; column: string | null };
}

export interface RowsPage {
  columns: RowsColumn[];
  rows: Cell[][];
  hasMore: boolean;
  total?: number;
  key: RowsKey;
}

/** `sort=col:asc`. The column is everything before the last colon. */
export function formatSort(sort: Sort): string {
  return `${sort.col}:${sort.dir}`;
}

export function parseSort(value: string): Sort | undefined {
  const at = value.lastIndexOf(":");
  if (at <= 0) return undefined;
  const dir = value.slice(at + 1);
  if (dir !== "asc" && dir !== "desc") return undefined;
  return { col: value.slice(0, at), dir };
}
