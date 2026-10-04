import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  define: { __VERSION__: JSON.stringify(pkg.version) },
  // For unit tests of pure UI modules (test/ui/); matches ui/vite.config.ts.
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@': path.resolve(import.meta.dirname, 'ui/src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke/**', 'test/live/**', '**/node_modules/**'],
    globalSetup: ['test/global-setup.ts'],
  },
});
