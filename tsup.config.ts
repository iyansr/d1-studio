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
  noExternal: [/.*/],
  external: ["node:sqlite", "bun:sqlite"],
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  esbuildOptions(options) {
    // jsonc-parser's `main` is UMD with runtime requires; its ESM build bundles cleanly.
    options.mainFields = ["module", "main"];
  },
});
