/**
 * Quotes an SQLite identifier. Only call it with names already checked
 * against the schema.
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
