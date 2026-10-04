import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

// Against a real D1 API; skipped unless D1S_LIVE_TOKEN and D1S_LIVE_ACCOUNT are set.
export default defineConfig({
  define: { __VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['test/live/**/*.test.ts'],
    reporters: ['verbose'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
