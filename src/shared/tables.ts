/** Internal tables hidden by default (UI-2): D1, Cloudflare and SQLite bookkeeping. */
export function isHiddenTable(name: string): boolean {
  return name.startsWith('_cf_') || name.startsWith('sqlite_') || name.startsWith('d1_');
}
