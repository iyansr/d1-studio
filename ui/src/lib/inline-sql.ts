import type { ParamValue } from "@shared/values";

/** A parameter as an SQL literal, for reading only: the statement still runs with it bound. */
export function sqlLiteral(value: ParamValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "object") return value.$int;
  return `'${value.replaceAll("'", "''")}'`;
}

/** The end of a quoted run starting at `from`, where a doubled `close` is an escape. */
function endOfQuote(sql: string, from: number, close: string): number {
  let i = from + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (sql[i + 1] === close) i += 2;
      else return i + 1;
    } else i++;
  }
  return sql.length;
}

/**
 * Replaces `?` and `?NNN` placeholders with their values. Quoted text and
 * comments are left alone, so a column named `"why?"` survives. Named
 * placeholders and missing values are left as written.
 */
export function inlineParams(sql: string, params: readonly ParamValue[]): string {
  let out = "";
  let next = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    let end = i + 1;
    if (c === "'" || c === '"' || c === "`") end = endOfQuote(sql, i, c);
    else if (c === "[") end = sql.indexOf("]", i) === -1 ? sql.length : sql.indexOf("]", i) + 1;
    else if (c === "-" && sql[i + 1] === "-") {
      end = sql.indexOf("\n", i) === -1 ? sql.length : sql.indexOf("\n", i);
    } else if (c === "/" && sql[i + 1] === "*") {
      end = sql.indexOf("*/", i + 2) === -1 ? sql.length : sql.indexOf("*/", i + 2) + 2;
    } else if (c === "?") {
      let j = i + 1;
      while (/\d/.test(sql[j] ?? "")) j++;
      const digits = sql.slice(i + 1, j);
      const index = digits === "" ? next : Number(digits) - 1;
      next = Math.max(next, index + 1);
      const value = params[index];
      out += value === undefined ? sql.slice(i, j) : sqlLiteral(value);
      i = j;
      continue;
    }
    out += sql.slice(i, end);
    i = end;
  }
  return out;
}
