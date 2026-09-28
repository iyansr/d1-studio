import { isHiddenTable } from "../shared/tables";
import type { Cell, ParamValue } from "../shared/values";
import { quoteIdent, quoteString } from "../sql/ident";
import type { QueryResult } from "./types";

/** Introspection runs over `Driver.query`, so both drivers share it (D5). */
export type QueryFn = (sql: string, params?: ParamValue[]) => Promise<QueryResult[]>;

export interface TableInfo {
  name: string;
  type: "table" | "view" | "virtual" | "shadow";
  withoutRowid: boolean;
  strict: boolean;
  /** `_cf_*`, `sqlite_*`, `d1_*` and FTS shadow tables (UI-2). */
  hidden: boolean;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  /** 1-based position in the primary key, or 0. */
  pk: number;
  /** A virtual-table hidden column. */
  hidden: boolean;
  generated: "virtual" | "stored" | null;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  /** `c` CREATE INDEX, `u` UNIQUE constraint, `pk` PRIMARY KEY. */
  origin: string;
  partial: boolean;
  /** Key columns; `null` for an expression or the rowid. */
  columns: (string | null)[];
  sql: string | null;
}

export interface ForeignKeyInfo {
  id: number;
  table: string;
  from: string[];
  /** `null` when the parent's primary key is implied. */
  to: (string | null)[];
  onUpdate: string;
  onDelete: string;
  match: string;
}

export interface TableSchema {
  name: string;
  type: TableInfo["type"];
  withoutRowid: boolean;
  strict: boolean;
  /** Rows have a usable `rowid`. */
  rowid: boolean;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  sql: string | null;
}

type Row = Record<string, Cell>;

/** Rows as objects keyed by column name (the PRAGMAs have unique names). */
function objects(result: QueryResult | undefined): Row[] {
  if (!result) return [];
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((c, i) => [c, row[i] ?? null])),
  );
}

const str = (v: Cell | undefined) => (typeof v === "string" ? v : v == null ? null : String(v));
const num = (v: Cell | undefined) => (typeof v === "number" ? v : Number(str(v) ?? 0));

export async function listTables(query: QueryFn): Promise<TableInfo[]> {
  let tables: TableInfo[];
  try {
    const [result] = await query("PRAGMA table_list");
    tables = objects(result)
      .filter((r) => r.schema === "main")
      .map((r) => {
        const name = String(r.name);
        const type = String(r.type) as TableInfo["type"];
        return {
          name,
          type,
          withoutRowid: num(r.wr) === 1,
          strict: num(r.strict) === 1,
          hidden: isHiddenTable(name) || type === "shadow",
        };
      });
  } catch {
    // SQLite < 3.37 has no table_list.
    const [result] = await query(
      "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view')",
    );
    tables = objects(result).map((r) => {
      const name = String(r.name);
      const sql = str(r.sql) ?? "";
      const type =
        r.type === "view" ? "view" : /^CREATE\s+VIRTUAL/i.test(sql) ? "virtual" : "table";
      return {
        name,
        type,
        withoutRowid: /\bWITHOUT\s+ROWID\s*[,;]?\s*$/i.test(sql),
        strict: /\)\s*(?:WITHOUT\s+ROWID\s*,\s*)?STRICT\b/i.test(sql),
        hidden: isHiddenTable(name),
      };
    });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}

/** Row counts per name; `null` when a count fails (e.g. a broken view). */
export async function countRows(
  query: QueryFn,
  names: string[],
): Promise<Record<string, number | null>> {
  const counts: Record<string, number | null> = {};
  const CHUNK = 100;
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    try {
      const select = chunk.map((n) => `(SELECT count(*) FROM ${quoteIdent(n)})`).join(", ");
      const [result] = await query(`SELECT ${select}`);
      chunk.forEach((n, j) => {
        counts[n] = num(result?.rows[0]?.[j]);
      });
    } catch {
      for (const n of chunk) {
        try {
          const [result] = await query(`SELECT count(*) FROM ${quoteIdent(n)}`);
          counts[n] = num(result?.rows[0]?.[0]);
        } catch {
          counts[n] = null;
        }
      }
    }
  }
  return counts;
}

/** `table` must come from `listTables`; its name is inlined, quoted. */
export async function describe(query: QueryFn, table: TableInfo): Promise<TableSchema> {
  const t = quoteIdent(table.name);
  const [xinfo, indexList, fkList, schema] = await query(
    [
      `PRAGMA table_xinfo(${t})`,
      `PRAGMA index_list(${t})`,
      `PRAGMA foreign_key_list(${t})`,
      `SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ${quoteString(table.name)}`,
    ].join(";\n"),
  );

  const columns: ColumnInfo[] = objects(xinfo).map((r) => {
    const hidden = num(r.hidden);
    return {
      cid: num(r.cid),
      name: String(r.name),
      type: str(r.type) ?? "",
      notNull: num(r.notnull) === 1,
      defaultValue: str(r.dflt_value),
      pk: num(r.pk),
      hidden: hidden === 1,
      generated: hidden === 2 ? "virtual" : hidden === 3 ? "stored" : null,
    };
  });
  const primaryKey = columns
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

  const schemaRows = objects(schema);
  const sqlOf = (type: string, name: string) =>
    str(schemaRows.find((r) => r.type === type && r.name === name)?.sql);

  const indexRows = objects(indexList);
  const indexColumns = indexRows.length
    ? await query(
        indexRows.map((r) => `PRAGMA index_xinfo(${quoteIdent(String(r.name))})`).join(";\n"),
      )
    : [];
  const indexes: IndexInfo[] = indexRows
    .map((r, i) => {
      const name = String(r.name);
      return {
        name,
        unique: num(r.unique) === 1,
        origin: String(r.origin),
        partial: num(r.partial) === 1,
        columns: objects(indexColumns[i])
          .filter((c) => num(c.key) === 1)
          .sort((a, b) => num(a.seqno) - num(b.seqno))
          .map((c) => str(c.name)),
        sql: sqlOf("index", name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const fks = new Map<number, ForeignKeyInfo>();
  for (const r of objects(fkList).sort(
    (a, b) => num(a.id) - num(b.id) || num(a.seq) - num(b.seq),
  )) {
    const id = num(r.id);
    let fk = fks.get(id);
    if (!fk) {
      fk = {
        id,
        table: String(r.table),
        from: [],
        to: [],
        onUpdate: String(r.on_update),
        onDelete: String(r.on_delete),
        match: String(r.match),
      };
      fks.set(id, fk);
    }
    fk.from.push(String(r.from));
    fk.to.push(str(r.to));
  }

  return {
    name: table.name,
    type: table.type,
    withoutRowid: table.withoutRowid,
    strict: table.strict,
    rowid: !table.withoutRowid && table.type === "table",
    columns,
    primaryKey,
    indexes,
    foreignKeys: [...fks.values()],
    sql: sqlOf(table.type === "view" ? "view" : "table", table.name),
  };
}

/** A table or view with its column names and types, for editor autocomplete. */
export interface SchemaTable {
  name: string;
  type: TableInfo["type"];
  columns: { name: string; type: string }[];
}

/**
 * Every table and view with its columns. One query through
 * `pragma_table_info()`; if that fails (a broken view, or no table-valued
 * pragmas), one `table_info` per table.
 */
export async function allColumns(query: QueryFn, tables: TableInfo[]): Promise<SchemaTable[]> {
  const byName = new Map<string, SchemaTable>(
    tables.map((t) => [t.name, { name: t.name, type: t.type, columns: [] }]),
  );
  try {
    const [result] = await query(
      "SELECT m.name, p.name, p.type FROM sqlite_schema m JOIN pragma_table_info(m.name) p" +
        " WHERE m.type IN ('table', 'view') ORDER BY m.name, p.cid",
    );
    for (const [table, name, type] of result?.rows ?? []) {
      byName.get(String(table))?.columns.push({ name: String(name), type: str(type) ?? "" });
    }
  } catch {
    for (const t of byName.values()) {
      try {
        const [result] = await query(`PRAGMA table_info(${quoteIdent(t.name)})`);
        t.columns = objects(result).map((r) => ({ name: String(r.name), type: str(r.type) ?? "" }));
      } catch {
        t.columns = [];
      }
    }
  }
  return [...byName.values()];
}

/** A table or column name that isn't in the schema. */
export class UnknownIdentifierError extends Error {
  override name = "UnknownIdentifierError";
  constructor(
    message: string,
    readonly kind: "table" | "column",
  ) {
    super(message);
  }
}

/**
 * Per-session schema cache. Identifiers from the browser are validated here
 * before they are quoted into SQL. Invalidate after any write or DDL.
 */
export class SchemaCache {
  private tablesPromise?: Promise<TableInfo[]>;
  private allPromise?: Promise<SchemaTable[]>;
  private schemas = new Map<string, Promise<TableSchema>>();

  constructor(private readonly query: QueryFn) {}

  tables(): Promise<TableInfo[]> {
    this.tablesPromise ??= listTables(this.query).catch((err) => {
      this.tablesPromise = undefined;
      throw err;
    });
    return this.tablesPromise;
  }

  /** Every table and view with its columns (editor autocomplete). */
  all(): Promise<SchemaTable[]> {
    this.allPromise ??= this.tables()
      .then((tables) => allColumns(this.query, tables))
      .catch((err) => {
        this.allPromise = undefined;
        throw err;
      });
    return this.allPromise;
  }

  async assertTable(name: string): Promise<TableInfo> {
    const table = (await this.tables()).find((t) => t.name === name);
    if (!table) throw new UnknownIdentifierError(`No such table: ${name}`, "table");
    return table;
  }

  async describe(name: string): Promise<TableSchema> {
    const table = await this.assertTable(name);
    let schema = this.schemas.get(name);
    if (!schema) {
      schema = describe(this.query, table);
      schema.catch(() => this.schemas.delete(name));
      this.schemas.set(name, schema);
    }
    return schema;
  }

  async assertColumns(table: string, columns: string[]): Promise<TableSchema> {
    const schema = await this.describe(table);
    const known = new Set(schema.columns.map((c) => c.name));
    const missing = columns.find((c) => !known.has(c));
    if (missing !== undefined) {
      throw new UnknownIdentifierError(`No such column: ${table}.${missing}`, "column");
    }
    return schema;
  }

  invalidate(): void {
    this.tablesPromise = undefined;
    this.allPromise = undefined;
    this.schemas.clear();
  }
}
