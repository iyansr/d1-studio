/**
 * Quotes an SQLite identifier. Only call it with names already checked
 * against the schema.
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quotes a string literal. For inlining schema names where a statement can't
 * take bound parameters (multi-statement introspection queries).
 */
export function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
