import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { UsageError } from "./args";

export const DEFAULT_PORT = 4101;
/** How many ports after the chosen one to try when it is busy. */
const FALLBACK_TRIES = 10;

export interface ResolvedPort {
  port: number;
  /** Only an explicit `--port` fails when busy (D11). */
  strict: boolean;
}

export function resolvePort(input: {
  flag?: string;
  env?: string;
  fallback?: number;
}): ResolvedPort {
  if (input.flag !== undefined) {
    return { port: parsePort(input.flag, "--port"), strict: true };
  }
  if (input.env !== undefined && input.env !== "") {
    return { port: parsePort(input.env, "D1_STUDIO_PORT"), strict: false };
  }
  return { port: input.fallback ?? DEFAULT_PORT, strict: false };
}

/** `0` asks the OS for any free port (used by the e2e tests). */
function parsePort(value: string, source: string): number {
  const port = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(
      `${source} must be an integer from 1 to 65535, or 0 for any free port (got "${value}").`,
    );
  }
  return port;
}

export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

export interface Listening {
  server: Server;
  port: number;
}

/**
 * Binds `app` to `host:port`. A busy non-strict port falls through to the next
 * ten ports; a busy strict port throws.
 */
export async function listen(
  app: FetchApp,
  host: string,
  port: number,
  strict: boolean,
): Promise<Listening> {
  const last = strict || port === 0 ? port : Math.min(port + FALLBACK_TRIES, 65535);
  for (let candidate = port; candidate <= last; candidate++) {
    const server = createServer(getRequestListener(app.fetch));
    try {
      await bind(server, host, candidate);
      const address = server.address();
      return { server, port: typeof address === "object" && address ? address.port : candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  if (strict) {
    throw new UsageError(`Port ${port} is in use. Choose another with \`--port\`.`);
  }
  throw new UsageError(`Ports ${port}–${last} are all in use. Choose another with \`--port\`.`);
}

function bind(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
