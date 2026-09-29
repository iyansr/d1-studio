import { readFileSync } from "node:fs";
import path from "node:path";

/** A canned API response: `{ status, headers?, body }` (test/fixtures/d1-api/). */
export interface Canned {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export function fixture(name: string): Canned {
  const file = path.resolve(import.meta.dirname, "../fixtures/d1-api", `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Canned;
}

export function respond(canned: Canned): Response {
  return new Response(JSON.stringify(canned.body), {
    status: canned.status,
    headers: { "Content-Type": "application/json", ...canned.headers },
  });
}

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

/**
 * A fetch stub. `handler` answers each request; every request is recorded.
 * A handler that returns an `Error` makes fetch reject with it.
 */
export function stubFetch(
  handler: (
    req: Recorded,
    index: number,
  ) => Canned | Response | Error | Promise<Canned | Response | Error>,
) {
  const requests: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const out = await handler(req, requests.length - 1);
    if (out instanceof Error) throw out;
    return out instanceof Response ? out : respond(out);
  }) as typeof fetch;
  return { fetch: fn, requests };
}

/** Replays the canned responses in order; the last one repeats. */
export function sequence(...responses: Canned[]) {
  return stubFetch((_, i) => responses[Math.min(i, responses.length - 1)] as Canned);
}
