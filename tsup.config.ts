import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  // Keep dist/ui (built first by `build:ui`).
  clean: false,
  splitting: false,
  sourcemap: false,
  // Bundle every dependency (D7) except the runtime SQLite modules; tsup's
  // noExternal wins over external, so exclude them here.
  noExternal: [/^(?!(?:node|bun):sqlite$)/],
  external: ["node:sqlite", "bun:sqlite"],
  // `node:sqlite` has no bare `sqlite` alias.
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  esbuildOptions(options) {
    // jsonc-parser's `main` is UMD with runtime requires; its ESM build bundles cleanly.
    options.mainFields = ["module", "main"];
  },
});
