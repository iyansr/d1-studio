import type { Secret } from "./secret";

/** The only host the token is ever sent to. */
export const API_BASE = "https://api.cloudflare.com/client/v4";

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
/** A longer `Retry-After` is surfaced to the user instead of waited out. */
const MAX_WAIT_MS = 10_000;
/** Pagination guard against an API that never reports the last page. */
const MAX_PAGES = 100;

export interface D1Meta {
  changes?: number;
  /** SQL time in ms, without the network. */
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
  timings?: { sql_duration_ms?: number };
}

/** One statement's result from the `raw` endpoint. */
export interface D1RawResult {
  success?: boolean;
  meta?: D1Meta;
  results?: { columns?: string[]; rows?: unknown[][] };
}

/** A statement as the API takes it. */
export interface D1Statement {
  sql: string;
  params?: unknown[];
}

export interface Account {
  id: string;
  name: string;
}

export interface D1Database {
  uuid: string;
  name: string;
  created_at?: string;
}

export interface D1Target {
  accountId: string;
  databaseId: string;
}

/**
 * A failed API call. `message` is the API's own text, verbatim (UI-8); a
 * status of 0 means the API was never reached.
 */
export class D1ApiError extends Error {
  override name = "D1ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    /** Seconds, from `Retry-After`. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export interface ClientOptions {
  token: Secret;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result: T;
  result_info?: { page?: number; per_page?: number; count?: number; total_count?: number };
}

/** The Cloudflare REST API, limited to what the studio needs. */
export class D1Client {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: ClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  /**
   * Runs `sql` (one or more statements) through the `raw` endpoint: one
   * result per statement. Only a read may be retried.
   */
  async raw(
    target: D1Target,
    stmt: D1Statement,
    options: { retry: boolean },
  ): Promise<D1RawResult[]> {
    const body = await this.request<D1RawResult[]>("POST", rawPath(target), stmt, options.retry);
    return body.result ?? [];
  }

  /** Runs single statements as one transaction (S1). */
  async batch(
    target: D1Target,
    stmts: D1Statement[],
    options: { retry: boolean },
  ): Promise<D1RawResult[]> {
    const body = await this.request<D1RawResult[]>(
      "POST",
      rawPath(target),
      { batch: stmts },
      options.retry,
    );
    return body.result ?? [];
  }

  listAccounts(): Promise<Account[]> {
    return this.paginate<Account>("/accounts", 50);
  }

  listDatabases(accountId: string): Promise<D1Database[]> {
    return this.paginate<D1Database>(`/accounts/${seg(accountId)}/d1/database`, 100);
  }

  async getDatabase(accountId: string, id: string): Promise<D1Database> {
    const path = `/accounts/${seg(accountId)}/d1/database/${seg(id)}`;
    return (await this.request<D1Database>("GET", path, undefined, true)).result;
  }

  private async paginate<T>(path: string, perPage: number): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.request<T[]>(
        "GET",
        `${path}?page=${page}&per_page=${perPage}`,
        undefined,
        true,
      );
      const items = body.result ?? [];
      all.push(...items);
      const info = body.result_info;
      const size = info?.per_page ?? perPage;
      const total = info?.total_count;
      // A short page is the last one, whatever `total_count` says.
      const done = items.length < size || (total !== undefined && all.length >= total);
      if (done) break;
    }
    return all;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    retry: boolean,
  ): Promise<Envelope<T>> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(`${API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.token.reveal()}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw networkError(err);
      }

      const envelope = (await res.json().catch(() => undefined)) as Envelope<T> | undefined;
      if (res.ok && envelope && envelope.success !== false) return envelope;

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      if (retry && (res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const wait = retryAfter !== undefined ? retryAfter * 1000 : this.backoff(attempt);
        if (wait <= MAX_WAIT_MS) {
          await this.sleep(wait);
          continue;
        }
      }
      const first = envelope?.errors?.find((e) => typeof e.message === "string");
      const message =
        envelope?.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join("; ") || `Cloudflare API request failed (HTTP ${res.status}).`;
      throw new D1ApiError(message, res.status, first?.code, retryAfter);
    }
  }

  /** 250 ms, 500 ms, 1 s, … with ±50% jitter. */
  private backoff(attempt: number): number {
    return Math.round(250 * 2 ** attempt * (0.5 + this.random()));
  }
}

function rawPath({ accountId, databaseId }: D1Target): string {
  return `/accounts/${seg(accountId)}/d1/database/${seg(databaseId)}/raw`;
}

const seg = (value: string) => encodeURIComponent(value);

/** Seconds from a `Retry-After` value (delta-seconds or an HTTP date). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

function networkError(err: unknown): D1ApiError {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new D1ApiError(`The Cloudflare API didn't answer within ${TIMEOUT_MS / 1000} s.`, 0);
  }
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  const reason = cause ?? (err instanceof Error ? err.message : String(err));
  return new D1ApiError(`Couldn't reach the Cloudflare API: ${reason}`, 0);
}
