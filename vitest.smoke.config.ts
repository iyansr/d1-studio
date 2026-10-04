import { defineConfig } from 'vitest/config';

// Runs against the built dist/cli.js; `pnpm build` first.
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Verbose so CI logs the measured startup time.
    reporters: ['verbose'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
