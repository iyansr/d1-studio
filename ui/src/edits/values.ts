import { affinity } from '@/grid/cells';
import type { CellValue } from '@shared/edits';
import type { Cell } from '@shared/values';

export type InputKind = 'number' | 'text';

/**
 * INTEGER and REAL columns get a number input (plan 04-T6). An untyped
 * column has no affinity of its own, so it follows what the cell holds.
 */
export function inputKind(type: string, original: Cell | undefined): InputKind {
  const kind = affinity(type);
  if (kind === 'integer' || kind === 'real') return 'number';
  const holdsNumber =
    typeof original === 'number' ||
    (typeof original === 'object' && original !== null && '$int' in original);
  return kind === 'blob' && type === '' && holdsNumber ? 'number' : 'text';
}

/** What the editor starts with. NULL and BLOBs start empty. */
export function editText(value: Cell | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return '$int' in value ? value.$int : '';
}

export type Parsed = { ok: true; value: CellValue } | { ok: false; message: string };

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * A number typed into the editor. Integers past 2^53 stay exact as `$int`;
 * everything else is a finite JS number.
 */
export function parseNumber(text: string): Parsed {
  const t = text.trim();
  if (t === '') return { ok: false, message: 'Enter a number, or set NULL.' };
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return { ok: true, value: n };
    const big = BigInt(t);
    if (big < INT64_MIN || big > INT64_MAX) {
      return { ok: false, message: "That doesn't fit in a 64-bit integer." };
    }
    return { ok: true, value: { $int: big.toString() } };
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, message: `"${t}" isn't a number.` };
  return { ok: true, value: n };
}

export function parseInput(kind: InputKind, text: string): Parsed {
  return kind === 'number' ? parseNumber(text) : { ok: true, value: text };
}

/** `null` when `text` is valid JSON that is an object or array; otherwise why not. */
export function jsonProblem(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? null
      : 'The value must be a JSON object or array.';
  } catch (err) {
    return err instanceof Error ? err.message : 'Not valid JSON.';
  }
}

/** Pretty-prints valid JSON with two spaces. */
export function formatJson(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2);
}
