import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const MISSING_UI = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>d1-studio</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem">
<h1>d1-studio</h1><p>The UI isn't built. Run <code>pnpm build</code>.</p>
</body></html>`;

/**
 * Serves the built UI with an SPA fallback. Vite's hashed files under
 * `/assets/` are cached forever; everything else revalidates.
 */
export function serveUi(uiDir: string) {
  const root = path.resolve(uiDir);

  return async (c: Context) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Bad request", 400);
    }
    const file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
    if (file !== root && !file.startsWith(root + path.sep)) return c.text("Not found", 404);

    if (await isFile(file)) {
      const immutable = rel.startsWith("/assets/");
      return send(c, file, immutable ? "public, max-age=31536000, immutable" : "no-cache");
    }
    // Paths that look like files 404; everything else is a client route.
    if (path.extname(rel) !== "") return c.text("Not found", 404);
    const index = path.join(root, "index.html");
    if (await isFile(index)) return send(c, index, "no-cache");
    return c.html(MISSING_UI, 500);
  };
}

async function send(c: Context, file: string, cacheControl: string) {
  const body = await readFile(file);
  return c.body(body, 200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": cacheControl,
  });
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
