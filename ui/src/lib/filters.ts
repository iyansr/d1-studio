import { FILTER_OPS, type Filter, type FilterOp, UNARY_OPS } from "@shared/rows";
import type { ParamValue } from "@shared/values";
import { affinity } from "@/grid/cells";

export const OP_LABELS: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  gt: ">",
  le: "≤",
  ge: "≥",
  like: "LIKE",
  nlike: "NOT LIKE",
  null: "IS NULL",
  nnull: "IS NOT NULL",
};

export const OP_ITEMS = FILTER_OPS.map((op) => ({ value: op, label: OP_LABELS[op] }));

export interface Draft {
  key: number;
  col: string;
  op: FilterOp;
  value: string;
}

let nextKey = 0;
export const newKey = () => nextKey++;
export const draftOf = (f: Filter): Draft => ({
  key: newKey(),
  col: f.col,
  op: f.op,
  value:
    f.value === undefined || f.value === null
      ? ""
      : typeof f.value === "object"
        ? f.value.$int
        : String(f.value),
});

export const numeric = (type: string) => ["integer", "real", "numeric"].includes(affinity(type));

/**
 * The value to send, or an error. Numeric-affinity columns take numbers;
 * integers past ±2^53 travel as `{ $int }`.
 */
export function parseValue(draft: Draft, type: string): { value?: ParamValue; error?: string } {
  if (UNARY_OPS.has(draft.op)) return {};
  const text = draft.value;
  if (text.trim() === "") return { error: "Enter a value." };
  if (!numeric(type) || draft.op === "like" || draft.op === "nlike") return { value: text };
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed) && !Number.isSafeInteger(Number(trimmed))) {
    return { value: { $int: trimmed } };
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? { value: n } : { error: `${draft.col} is numeric; enter a number.` };
}
