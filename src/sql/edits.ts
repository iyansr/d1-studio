import type { TableSchema } from "../drivers/introspect";
import type { Stmt } from "../drivers/types";
import { type CellValue, type EditOp, MAX_OPS, type RowKey } from "../shared/edits";
import type { ParamValue } from "../shared/values";
import { quoteIdent } from "./ident";
import { rowidName } from "./rows-query";

/** An edit that can't be compiled (400). Messages are shown to the user. */
export class EditError extends Error {
  override name = "EditError";
  constructor(
    message: string,
    /** The offending op, when it was one op's fault. */
    readonly opIndex?: number,
  ) {
    super(message);
  }
}

/** A compiled statement and the op it came from (ops are reordered). */
export interface EditStmt extends Stmt {
  params: ParamValue[];
  opIndex: number;
  op: EditOp["op"];
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER = /^-?\d+$/;

/** Deletes first, so deleting a row and re-adding it can't hit a unique key. */
const ORDER: Record<EditOp["op"], number> = { delete: 0, update: 1, insert: 2 };

const KIND_NAMES: Record<Exclude<TableSchema["type"], "table">, string> = {
  view: "a view",
  virtual: "a virtual table",
  shadow: "an internal table",
};

/**
 * Compiles staged ops into parameterised statements (D6). Pure: every table
 * and column is checked against `schema` and quoted, every value is bound.
 * Statements come out deletes, then updates, then inserts.
 */
export function compileEdits(schema: TableSchema, ops: EditOp[]): EditStmt[] {
  if (schema.type !== "table") {
    throw new EditError(`${schema.name} is ${KIND_NAMES[schema.type]} and can't be edited.`);
  }
  const rowid = schema.rowid ? rowidName(schema) : undefined;
  if (!rowid && schema.primaryKey.length === 0) {
    throw new EditError(
      `${schema.name} has no rowid or primary key to identify rows, so it can't be edited.`,
    );
  }
  const table = quoteIdent(schema.name);
  const columns = new Map(schema.columns.map((c) => [c.name, c]));

  const column = (name: string, opIndex: number): string => {
    const col = columns.get(name);
    if (!col) throw new EditError(`No such column: ${schema.name}.${name}`, opIndex);
    if (col.generated || col.hidden) {
      throw new EditError(
        `Column ${schema.name}.${name} is generated and can't be written.`,
        opIndex,
      );
    }
    return quoteIdent(name);
  };

  const where = (key: RowKey, opIndex: number): { sql: string; params: ParamValue[] } => {
    if (key.kind === "rowid") {
      if (!rowid)
        throw new EditError(`${schema.name} has no rowid; identify rows by key.`, opIndex);
      return { sql: `${rowid} = ?`, params: [rowidParam(key.rowid, opIndex)] };
    }
    const pk = schema.primaryKey;
    const given = Object.keys(key.values);
    const wrong = given.find((c) => !pk.includes(c)) ?? pk.find((c) => !given.includes(c));
    if (pk.length === 0 || wrong !== undefined) {
      throw new EditError(
        `The row key must be exactly the primary key (${pk.map((c) => quoteIdent(c)).join(", ")}) of ${schema.name}.`,
        opIndex,
      );
    }
    return {
      sql: pk.map((c) => `${quoteIdent(c)} = ?`).join(" AND "),
      params: pk.map((c) => {
        const value = key.values[c] as CellValue;
        if (value === null) throw new EditError(`Key column ${c} can't be NULL.`, opIndex);
        return param(value, c, opIndex);
      }),
    };
  };

  const compile = (op: EditOp, opIndex: number): EditStmt => {
    switch (op.op) {
      case "delete": {
        const w = where(op.key, opIndex);
        return {
          sql: `DELETE FROM ${table} WHERE ${w.sql}`,
          params: w.params,
          expectChanges: 1,
          opIndex,
          op: "delete",
        };
      }
      case "update": {
        const names = Object.keys(op.set);
        if (names.length === 0)
          throw new EditError("An update needs at least one column.", opIndex);
        const sets = names.map((n) => `${column(n, opIndex)} = ?`);
        const values = names.map((n) => param(op.set[n] as CellValue, n, opIndex));
        const w = where(op.key, opIndex);
        return {
          sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${w.sql}`,
          params: [...values, ...w.params],
          expectChanges: 1,
          opIndex,
          op: "update",
        };
      }
      case "insert": {
        const names = Object.keys(op.values);
        if (names.length === 0) {
          return { sql: `INSERT INTO ${table} DEFAULT VALUES`, params: [], opIndex, op: "insert" };
        }
        const quoted = names.map((n) => column(n, opIndex));
        const values = names.map((n) => param(op.values[n] as CellValue, n, opIndex));
        return {
          sql: `INSERT INTO ${table} (${quoted.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
          params: values,
          opIndex,
          op: "insert",
        };
      }
      default:
        throw new EditError(`Unknown edit op "${String((op as { op?: unknown }).op)}".`, opIndex);
    }
  };

  return ops.map((op, i) => compile(op, i)).sort((a, b) => ORDER[a.op] - ORDER[b.op]);
}

/** A rowid: a safe integer, or a decimal string for one past 2^53. */
function rowidParam(rowid: number | string, opIndex: number): ParamValue {
  if (typeof rowid === "number" && Number.isSafeInteger(rowid)) return rowid;
  if (typeof rowid === "string" && INTEGER.test(rowid) && inInt64(rowid)) return { $int: rowid };
  throw new EditError(`Bad rowid ${JSON.stringify(rowid)}.`, opIndex);
}

/** Checks one value and passes it on as a bound parameter. */
function param(value: CellValue, column: string, opIndex: number): ParamValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new EditError(`Column ${column}: ${String(value)} isn't a valid number.`, opIndex);
  }
  if (typeof value === "object" && value !== null) {
    const v = value as { $int?: unknown; $blob?: unknown };
    if (typeof v.$int === "string") {
      if (INTEGER.test(v.$int) && inInt64(v.$int)) return { $int: v.$int };
      throw new EditError(`Column ${column}: ${v.$int} isn't a 64-bit integer.`, opIndex);
    }
    if ("$blob" in v) throw new EditError(`Column ${column}: BLOBs can't be edited yet.`, opIndex);
  }
  throw new EditError(`Column ${column}: unsupported value ${JSON.stringify(value)}.`, opIndex);
}

function inInt64(digits: string): boolean {
  const n = BigInt(digits);
  return n >= INT64_MIN && n <= INT64_MAX;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks the shape of `ops` from a request body. Values and identifiers are
 * checked when the ops are compiled.
 */
export function parseEditOps(value: unknown): EditOp[] {
  if (!Array.isArray(value)) throw new EditError('"ops" must be an array.');
  if (value.length === 0) throw new EditError("There is nothing to apply.");
  if (value.length > MAX_OPS) {
    throw new EditError(`At most ${MAX_OPS} changes can be applied at once (got ${value.length}).`);
  }
  return value.map((item: unknown, i): EditOp => {
    if (!isRecord(item)) throw new EditError("Each op must be an object.", i);
    switch (item.op) {
      case "insert":
        if (!isRecord(item.values)) throw new EditError('An insert needs a "values" object.', i);
        return { op: "insert", values: item.values as Record<string, CellValue> };
      case "update":
        if (!isRecord(item.set)) throw new EditError('An update needs a "set" object.', i);
        return {
          op: "update",
          key: parseKey(item.key, i),
          set: item.set as Record<string, CellValue>,
        };
      case "delete":
        return { op: "delete", key: parseKey(item.key, i) };
      default:
        throw new EditError(`Unknown edit op ${JSON.stringify(item.op)}.`, i);
    }
  });
}

function parseKey(key: unknown, opIndex: number): RowKey {
  if (isRecord(key)) {
    if (key.kind === "rowid" && (typeof key.rowid === "number" || typeof key.rowid === "string")) {
      return { kind: "rowid", rowid: key.rowid };
    }
    if (key.kind === "pk" && isRecord(key.values)) {
      return { kind: "pk", values: key.values as Record<string, CellValue> };
    }
  }
  throw new EditError(
    'An op needs a "key": { kind: "rowid", rowid } or { kind: "pk", values }.',
    opIndex,
  );
}
