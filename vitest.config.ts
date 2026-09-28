import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  define: { __VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**", "**/node_modules/**"],
    globalSetup: ["test/global-setup.ts"],
  },
});
