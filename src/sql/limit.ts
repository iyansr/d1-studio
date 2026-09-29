import { classify } from "./classify";
import { splitStatements } from "./split";
import { isKeyword } from "./tokenize";

/** Rows shown for an unbounded remote editor query (T6). */
export const AUTO_LIMIT = 1000;

/**
 * Appends `LIMIT 1001` to a single unbounded `SELECT`, `WITH … SELECT` or
 * `VALUES`, so a remote query can't read a whole table by accident (D1
 * bills per row read). One row past the limit tells the caller there were
 * more. On a compound query the limit applies to the whole compound.
 */
export function applyAutoLimit(sql: string): { sql: string; applied: boolean } {
  const unchanged = { sql, applied: false };
  const statements = splitStatements(sql);
  const [stmt] = statements;
  if (!stmt || statements.length !== 1) return unchanged;

  const { kind, keyword } = classify(stmt.tokens);
  if (kind !== "read" || (keyword !== "SELECT" && keyword !== "VALUES")) return unchanged;
  if (stmt.tokens.some((t) => t.depth === 0 && isKeyword(t, "LIMIT"))) return unchanged;

  // Drops the trailing `;` and any comment after the last token.
  const last = stmt.tokens[stmt.tokens.length - 1];
  if (!last) return unchanged;
  return { sql: `${sql.slice(stmt.start, last.end)} LIMIT ${AUTO_LIMIT + 1}`, applied: true };
}
