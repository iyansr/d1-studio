import type { TableSchema } from "../drivers/introspect";
import {
  FILTER_OPS,
  type Filter,
  type FilterOp,
  PAGE_SIZES,
  type PageSize,
  parseSort,
  ROWID_COLUMN,
  type RowsColumn,
  type RowsKey,
  type Sort,
  UNARY_OPS,
} from "../shared/rows";
import type { ParamValue } from "../shared/values";
import { quoteIdent } from "./ident";

/** A bad rows request (400). Messages are shown to the user. */
export class RowsQueryError extends Error {
  override name = "RowsQueryError";
}

export interface RowsParams {
  limit: PageSize;
  offset: number;
  sort: Sort[];
  filters: Filter[];
  count: boolean;
}

/** Raw query-string values, as Hono hands them over. */
export interface RawRowsParams {
  limit?: string;
  offset?: string;
  sort?: string[];
  f?: string;
  count?: string;
}

const MAX_SORTS = 16;
const MAX_FILTERS = 32;

const isParamValue = (v: unknown): v is ParamValue =>
  v === null ||
  typeof v === "number" ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "object" && typeof (v as { $int?: unknown }).$int === "string");

export function parseRowsParams(raw: RawRowsParams): RowsParams {
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if (!PAGE_SIZES.includes(limit as PageSize)) {
    throw new RowsQueryError(`"limit" must be one of ${PAGE_SIZES.join(", ")}.`);
  }

  const offset = raw.offset === undefined ? 0 : Number(raw.offset);
  if (!/^\d+$/.test(raw.offset ?? "0") || !Number.isSafeInteger(offset)) {
    throw new RowsQueryError('"offset" must be a whole number, 0 or more.');
  }

  const sortValues = raw.sort ?? [];
  if (sortValues.length > MAX_SORTS) throw new RowsQueryError(`At most ${MAX_SORTS} sorts.`);
  const sort = sortValues.map((value) => {
    const parsed = parseSort(value);
    if (!parsed) throw new RowsQueryError(`Bad sort "${value}". Use column:asc or column:desc.`);
    return parsed;
  });

  return {
    limit: limit as PageSize,
    offset,
    sort,
    filters: raw.f === undefined || raw.f === "" ? [] : parseFilters(raw.f),
    count: raw.count === "1",
  };
}

function parseFilters(json: string): Filter[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new RowsQueryError('"f" must be a JSON array of filters.');
  }
  if (!Array.isArray(value)) throw new RowsQueryError('"f" must be a JSON array of filters.');
  if (value.length > MAX_FILTERS) throw new RowsQueryError(`At most ${MAX_FILTERS} filters.`);
  return value.map((item: unknown): Filter => {
    const f = item as { col?: unknown; op?: unknown; value?: unknown } | null;
    if (typeof f !== "object" || f === null || typeof f.col !== "string") {
      throw new RowsQueryError('Each filter needs a "col" string.');
    }
    if (typeof f.op !== "string" || !FILTER_OPS.includes(f.op as FilterOp)) {
      throw new RowsQueryError(`Unknown filter op "${String(f.op)}".`);
    }
    const op = f.op as FilterOp;
    if (UNARY_OPS.has(op)) return { col: f.col, op };
    if (f.value === undefined || f.value === null || !isParamValue(f.value)) {
      throw new RowsQueryError(`The "${op}" filter on ${f.col} needs a value.`);
    }
    return { col: f.col, op, value: f.value };
  });
}

const OPERATORS: Record<FilterOp, string> = {
  eq: "= ?",
  ne: "!= ?",
  lt: "< ?",
  gt: "> ?",
  le: "<= ?",
  ge: ">= ?",
  like: "LIKE ?",
  nlike: "NOT LIKE ?",
  null: "IS NULL",
  nnull: "IS NOT NULL",
};

export interface RowsQuery {
  select: { sql: string; params: ParamValue[] };
  count?: { sql: string; params: ParamValue[] };
  key: RowsKey;
}

/**
 * The page query for a table or view. Every identifier is checked against
 * `schema`; values are bound; LIMIT and OFFSET are validated integers,
 * inlined (D10). One row past `limit` is fetched to compute `hasMore`.
 */
export function buildRowsQuery(schema: TableSchema, params: RowsParams): RowsQuery {
  const known = new Map(schema.columns.map((c) => [c.name, c]));
  const column = (name: string) => {
    if (!known.has(name)) throw new RowsQueryError(`No such column: ${schema.name}.${name}`);
    return quoteIdent(name);
  };

  const rowidAlias = schema.rowid ? rowidName(schema) : undefined;
  const key: RowsKey = rowidAlias
    ? { kind: "rowid", columns: [ROWID_COLUMN] }
    : schema.type === "table" && schema.primaryKey.length > 0
      ? { kind: "pk", columns: schema.primaryKey }
      : { kind: "none", columns: [] };

  const where: string[] = [];
  const values: ParamValue[] = [];
  for (const f of params.filters) {
    where.push(`${column(f.col)} ${OPERATORS[f.op]}`);
    if (!UNARY_OPS.has(f.op) && f.value !== undefined) values.push(f.value);
  }

  const order: string[] = [];
  const sorted = new Set<string>();
  for (const s of params.sort) {
    if (sorted.has(s.col)) continue;
    order.push(`${column(s.col)} ${s.dir === "asc" ? "ASC" : "DESC"}`);
    sorted.add(s.col);
  }
  // A unique tiebreaker keeps pages stable, including under a filter that
  // picks an index with another order.
  if (rowidAlias) order.push(rowidAlias);
  else if (key.kind === "pk") {
    for (const pk of key.columns) if (!sorted.has(pk)) order.push(column(pk));
  }

  const table = quoteIdent(schema.name);
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const orderSql = order.length > 0 ? ` ORDER BY ${order.join(", ")}` : "";
  const selectList = rowidAlias ? `${rowidAlias} AS ${quoteIdent(ROWID_COLUMN)}, *` : "*";
  const limit = Math.trunc(params.limit) + 1;
  const offset = Math.trunc(params.offset);

  return {
    select: {
      sql: `SELECT ${selectList} FROM ${table}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`,
      params: values,
    },
    count: params.count
      ? { sql: `SELECT count(*) FROM ${table}${whereSql}`, params: [...values] }
      : undefined,
    key,
  };
}

/** `rowid`, unless a real column shadows it; then `_rowid_` or `oid`. */
export function rowidName(schema: TableSchema): string | undefined {
  const names = new Set(schema.columns.map((c) => c.name.toLowerCase()));
  return ["rowid", "_rowid_", "oid"].find((alias) => !names.has(alias));
}

/**
 * Describes the result columns of a page: declared type, PK position and the
 * FK target. `parentKey` resolves an FK that names no parent column.
 */
export function rowsColumns(
  schema: TableSchema,
  names: string[],
  parentKey: (table: string) => string[] | undefined,
): RowsColumn[] {
  const fks = new Map<string, NonNullable<RowsColumn["fk"]>>();
  for (const fk of schema.foreignKeys) {
    fk.from.forEach((from, i) => {
      if (fks.has(from)) return;
      fks.set(from, { table: fk.table, column: fk.to[i] ?? parentKey(fk.table)?.[i] ?? null });
    });
  }
  const byName = new Map(schema.columns.map((c) => [c.name, c]));
  return names.map((name, i) => {
    if (i === 0 && name === ROWID_COLUMN) return { name, type: "INTEGER", pk: 0 };
    const col = byName.get(name);
    const out: RowsColumn = { name, type: col?.type ?? "", pk: col?.pk ?? 0 };
    const fk = fks.get(name);
    if (fk) out.fk = fk;
    return out;
  });
}
