import type { Cell } from "@shared/values";
import { formatBytes } from "@/lib/format";

/** Text longer than this, or JSON, opens in the expand panel (UI-6). */
export const LONG_TEXT = 80;
/** Tooltips show at most this much of a cell. */
export const TOOLTIP_CHARS = 500;

export type CellKind = "null" | "number" | "int" | "blob" | "json" | "text";

export function cellKind(value: Cell): CellKind {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "object") return "$int" in value ? "int" : "blob";
  return looksLikeJson(value) ? "json" : "text";
}

/** An object or array; plain strings, numbers and `null` don't count. */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(t);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/** The value as copied to the clipboard. */
export function cellText(value: Cell): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if ("$int" in value) return value.$int;
  return `BLOB (${value.$blob} bytes)`;
}

export function blobLabel(bytes: number): string {
  return `BLOB · ${formatBytes(bytes)}`;
}

export function isExpandable(value: Cell): boolean {
  const kind = cellKind(value);
  return (
    kind === "json" ||
    (kind === "text" && (value as string).length > LONG_TEXT) ||
    (kind === "text" && (value as string).includes("\n"))
  );
}

/** Pretty-printed JSON, or the text as is. */
export function expandedText(value: Cell): { text: string; language: "json" | "text" } {
  if (typeof value === "string" && looksLikeJson(value)) {
    return { text: JSON.stringify(JSON.parse(value), null, 2), language: "json" };
  }
  return { text: cellText(value), language: "text" };
}

/** SQLite column affinity from a declared type (§3.1 of the datatype docs). */
export function affinity(type: string): "integer" | "text" | "blob" | "real" | "numeric" {
  const t = type.toUpperCase();
  if (t.includes("INT")) return "integer";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "text";
  if (t.includes("BLOB") || t === "") return "blob";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "real";
  return "numeric";
}
