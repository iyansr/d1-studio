import type { Filter, PageSize, RowsPage, Sort } from "@shared/rows";
import { formatSort } from "@shared/rows";
import type { ParamValue } from "@shared/values";
import { QueryClient, queryOptions } from "@tanstack/react-query";
import { type ClientResponse, hc } from "hono/client";
import type { AppType } from "../../../src/server/app";

/** Types come from the server routes; there are no hand-written DTOs. */
const client = hc<AppType>("/");

/** An API error. `message` is the server's (for SQL errors, the engine's verbatim). */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly statementIndex?: number,
  ) {
    super(message);
  }
}

/** Set once any request gets a 401: the server restarted with a new token. */
export const sessionLost = (() => {
  let lost = false;
  const listeners = new Set<() => void>();
  return {
    get: () => lost,
    set: () => {
      lost = true;
      for (const l of listeners) l();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

type Ok<R> =
  R extends ClientResponse<infer T, infer S, "json"> ? (S extends 200 ? T : never) : never;

async function call<R extends ClientResponse<unknown, number, string>>(
  request: Promise<R>,
): Promise<Ok<R>> {
  let res: R;
  try {
    res = await request;
  } catch {
    throw new ApiError("Can't reach the studio server. Is d1-studio still running?", 0);
  }
  const body = (await res.json().catch(() => undefined)) as
    | { error?: { message?: string; statementIndex?: number } }
    | undefined;
  if (!res.ok) {
    if (res.status === 401) sessionLost.set();
    const error = body?.error;
    throw new ApiError(
      error?.message ?? `Request failed (${res.status})`,
      res.status,
      error?.statementIndex,
    );
  }
  return body as Ok<R>;
}

export const api = {
  meta: () => call(client.api.meta.$get()),
  tables: () => call(client.api.tables.$get()),
  schema: (name: string) => call(client.api.tables[":name"].schema.$get({ param: { name } })),
  schemaAll: () => call(client.api.schema.all.$get()),
  rows: (name: string, q: RowsRequest, signal?: AbortSignal) =>
    call(
      client.api.tables[":name"].rows.$get(
        {
          param: { name },
          query: {
            limit: String(q.limit),
            offset: String(q.offset),
            sort: q.sort.map(formatSort),
            f: q.filters.length > 0 ? JSON.stringify(q.filters) : "",
            count: q.count ? "1" : "0",
          },
        },
        { init: { signal } },
      ),
    ) as Promise<RowsPage>,
  query: (sql: string, params?: ParamValue[]) =>
    call(client.api.query.$post({ json: { sql, params } })),
  candidates: () => call(client.api.candidates.$get()),
  open: (candidateId: number) => call(client.api.open.$post({ json: { candidateId } })),
};

export type Meta = Awaited<ReturnType<typeof api.meta>>;
export type TableEntry = Awaited<ReturnType<typeof api.tables>>["tables"][number];
export type TableSchema = Awaited<ReturnType<typeof api.schema>>;
export type SchemaTable = Awaited<ReturnType<typeof api.schemaAll>>["tables"][number];
export type QueryResult = Awaited<ReturnType<typeof api.query>>["results"][number];
export type Candidate = Awaited<ReturnType<typeof api.candidates>>["candidates"][number];

export interface RowsRequest {
  limit: PageSize;
  offset: number;
  sort: Sort[];
  filters: Filter[];
  count: boolean;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A local tool: the data changes when the user (or their Worker) writes.
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: (count, err) =>
        !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
    },
  },
});

export const queries = {
  meta: () =>
    queryOptions({ queryKey: ["meta"], queryFn: api.meta, staleTime: Number.POSITIVE_INFINITY }),
  tables: () => queryOptions({ queryKey: ["tables"], queryFn: api.tables }),
  schema: (name: string) =>
    queryOptions({ queryKey: ["schema", name], queryFn: () => api.schema(name) }),
  schemaAll: () => queryOptions({ queryKey: ["schema-all"], queryFn: api.schemaAll }),
  rows: (name: string, q: RowsRequest) =>
    queryOptions({
      queryKey: ["rows", name, q],
      queryFn: ({ signal }) => api.rows(name, q, signal),
      // Keep the old page on screen while paging, but not across tables.
      placeholderData: (previous, previousQuery) =>
        previousQuery?.queryKey[1] === name ? previous : undefined,
    }),
  candidates: () => queryOptions({ queryKey: ["candidates"], queryFn: api.candidates }),
};
