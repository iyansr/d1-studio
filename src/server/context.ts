import { SchemaCache } from '../drivers/introspect';
import type { Driver } from '../drivers/types';
import type { CandidateFile } from '../local/locate';
import type { Notice } from '../shared/notices';

export interface DatabaseMeta {
  name: string;
  binding: string | null;
  id: string | null;
}

/** Row counts per visible table, and what counting them cost (D9). */
export interface TableCounts {
  counts: Record<string, number | null>;
  rowsRead: number;
}

export type Session =
  | {
      state: 'ready';
      driver: Driver;
      database: DatabaseMeta;
      schema: SchemaCache;
      /** Remote: counted once per session, then only on refresh (D9). */
      counts?: Promise<TableCounts>;
    }
  | {
      state: 'needs-db';
      candidates: CandidateFile[];
      /** The binding no file matched, for the picker's heading. */
      unmatched?: DatabaseMeta;
    };

/** The Cloudflare account behind a remote database, for the write confirmation. */
export interface AccountMeta {
  id: string;
  name: string | null;
}

export interface AppContext {
  version: string;
  mode: 'local' | 'remote';
  readOnly: boolean;
  token: string;
  /** The bind address and port. `port` is updated once the server is listening. */
  bind: { host: string; port: number };
  uiDir: string;
  /** Extra `host:port` values allowed in `Host` and `Origin` (the Vite dev server). */
  devHosts?: string[];
  session: Session;
  /** Remote only. */
  account?: AccountMeta;
  notices: Notice[];
  /** Opens a candidate picked in the UI (needs-db state). */
  openCandidate?: (candidate: CandidateFile) => Promise<{ driver: Driver; database: DatabaseMeta }>;
  /** Where unexpected errors are logged; never sent to the browser. */
  logError?: (err: unknown) => void;
}

export function readySession(driver: Driver, database: DatabaseMeta): Session {
  return { state: 'ready', driver, database, schema: new SchemaCache(driver.query.bind(driver)) };
}
