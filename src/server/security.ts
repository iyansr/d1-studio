import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

/** Session token: kept in memory only, carried once in the URL, then in a cookie. */
export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Cookie per port: browsers don't scope cookies by port (D8). */
export function cookieName(port: number): string {
  return `d1s_${port}`;
}

export function tokensEqual(a: string, b: string): boolean {
  // Hash first so lengths match and timingSafeEqual can't throw.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

const isWildcard = (host: string) => ['0.0.0.0', '::', '[::]'].includes(host);

function hostWithPort(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return `${bare.includes(':') ? `[${bare}]` : bare}:${port}`.toLowerCase();
}

/**
 * `Host` values the server answers to. Anything else is a DNS-rebinding
 * attempt. A wildcard bind also allows each local interface address.
 */
export function allowedHosts(bindHost: string, port: number): Set<string> {
  const hosts = ['127.0.0.1', 'localhost', '::1'];
  if (isWildcard(bindHost)) {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) hosts.push(a.address.split('%')[0] ?? a.address);
    }
  } else {
    hosts.push(bindHost);
  }
  const set = new Set(hosts.map((h) => hostWithPort(h, port)));
  // Browsers omit the default port. Iterate a copy: the loop adds to the set.
  // oxlint-disable-next-line unicorn/no-useless-spread
  if (port === 80) for (const h of [...set]) set.add(h.replace(/:80$/, ''));
  return set;
}

export interface SecurityOptions {
  token: string;
  /** Read per request: the port is only known once the server is listening. */
  getBind: () => { host: string; port: number };
  /** More `host:port` values to allow, e.g. the Vite dev server (`D1_STUDIO_DEV`). */
  extraHosts?: string[];
}

const UNAUTHORIZED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>d1-studio</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem">
<h1>d1-studio</h1>
<p>Open the link printed in your terminal.</p>
</body></html>`;

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

/** Response headers on every response, including errors (01-T8 step 4). */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('Content-Security-Policy', CSP);
  // The token is in the first URL.
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Content-Type-Options', 'nosniff');
  if (c.req.path.startsWith('/api/')) h.set('Cache-Control', 'no-store');
};

/** Host, then Origin, then session token (01-T8 steps 1–3). */
export function guard(options: SecurityOptions): MiddlewareHandler {
  let cached: { key: string; hosts: Set<string> } | undefined;
  const hostsFor = (host: string, port: number) => {
    const key = `${host}|${port}`;
    if (cached?.key !== key) {
      const hosts = allowedHosts(host, port);
      for (const h of options.extraHosts ?? []) hosts.add(h.toLowerCase());
      cached = { key, hosts };
    }
    return cached.hosts;
  };

  return async (c, next) => {
    const { host, port } = options.getBind();
    const hosts = hostsFor(host, port);
    const isApi = c.req.path.startsWith('/api/');
    const deny = (status: 401 | 403, message: string) =>
      isApi || status === 403
        ? c.json({ error: { message } }, status)
        : c.html(UNAUTHORIZED_HTML, status);

    // 1. Host: blocks DNS rebinding.
    const hostHeader = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
    if (!hosts.has(hostHeader)) return deny(403, 'Forbidden host');

    // 2. Origin: required for anything but GET/HEAD, and checked when present.
    const origin = c.req.header('origin');
    const safeMethod = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (origin === undefined ? !safeMethod : !isAllowedOrigin(origin, hosts)) {
      return deny(403, 'Forbidden origin');
    }

    // 3. Session token: `?t=` once, then the cookie.
    const name = cookieName(port);
    const url = new URL(c.req.url);
    const fromQuery = url.searchParams.get('t');
    if (fromQuery !== null) {
      if (!tokensEqual(fromQuery, options.token)) return deny(401, 'Unauthorized');
      url.searchParams.delete('t');
      c.header('Set-Cookie', `${name}=${options.token}; HttpOnly; SameSite=Strict; Path=/`);
      return c.redirect(`${url.pathname}${url.search}`, 302);
    }
    const cookie = getCookie(c, name);
    if (cookie === undefined || !tokensEqual(cookie, options.token)) {
      return deny(401, 'Unauthorized. Open the link printed in your terminal.');
    }
    await next();
  };
}

function isAllowedOrigin(origin: string, hosts: Set<string>): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && hosts.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}
