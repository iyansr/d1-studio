/**
 * A SQLite value as sent over JSON. Integers beyond ±(2^53 − 1) travel as
 * strings; BLOBs travel as their size only (UI-6).
 */
export type Cell = null | number | string | { $int: string } | { $blob: number };

/** A bound parameter as received over JSON. */
export type ParamValue = null | number | string | boolean | { $int: string };

export function encodeValue(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : { $int: value.toString() };
  }
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return { $blob: value.byteLength };
  if (value instanceof ArrayBuffer) return { $blob: value.byteLength };
  return String(value);
}

/** Converts a JSON param to a value the SQLite drivers can bind. */
export function decodeParam(value: ParamValue): null | number | string | bigint {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object" && typeof value.$int === "string" && /^-?\d+$/.test(value.$int)) {
    return BigInt(value.$int);
  }
  throw new TypeError(`Unsupported parameter value: ${JSON.stringify(value)}`);
}
