import type { CellValue } from "@shared/edits";
import { ROWID_COLUMN, type RowsKey } from "@shared/rows";
import type { Cell } from "@shared/values";
import type { RowRef } from "./staged-edits";

/**
 * How the server finds a row of the page, and the stable id staging keys on.
 * `undefined` when the row can't be edited: the table has no key, or a key
 * value is NULL or a BLOB.
 */
export function identifyRow(
  key: RowsKey,
  columns: readonly { name: string }[],
  row: readonly Cell[],
): RowRef | undefined {
  const at = (name: string) => columns.findIndex((c) => c.name === name);
  if (key.kind === "rowid") {
    const value = row[at(ROWID_COLUMN)];
    if (typeof value === "number")
      return { id: `r:${value}`, key: { kind: "rowid", rowid: value } };
    if (typeof value === "object" && value !== null && "$int" in value) {
      return { id: `r:${value.$int}`, key: { kind: "rowid", rowid: value.$int } };
    }
    return undefined;
  }
  if (key.kind === "pk") {
    const values: Record<string, CellValue> = {};
    for (const name of key.columns) {
      const value = row[at(name)];
      if (value === undefined || value === null) return undefined;
      if (typeof value === "object" && "$blob" in value) return undefined;
      values[name] = value;
    }
    const id = `p:${JSON.stringify(key.columns.map((name) => values[name]))}`;
    return { id, key: { kind: "pk", values } };
  }
  return undefined;
}
