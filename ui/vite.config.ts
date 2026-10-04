import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The CLI started by `pnpm dev` (see scripts/dev.mjs). */
const studio = `http://127.0.0.1:${process.env.D1_STUDIO_PORT ?? '4101'}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // API and value types shared with the server.
      '@shared': path.resolve(import.meta.dirname, '../src/shared'),
    },
  },
  build: {
    // Served by the CLI (01-T8).
    outDir: path.resolve(import.meta.dirname, '../dist/ui'),
    emptyOutDir: true,
    // No data: URIs: the CSP only allows fonts from 'self' (01-T8).
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': studio,
      // The token handshake: `/?t=…` sets the session cookie, then redirects.
      '^/[^?]*\\?(?:.*&)?t=': studio,
    },
  },
});
