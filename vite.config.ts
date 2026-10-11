import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Serve the bundled snapshot at `/snapshot/…` in dev and copy it into `dist/`
 * for production. The API reads it from the same path through the Cloudflare
 * Pages ASSETS binding, so dev and production behave identically.
 */
function snapshotPlugin(): Plugin {
  const snapshotDir = path.resolve(__dirname, 'data', 'snapshot');
  return {
    name: 'skyline-snapshot',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith('/snapshot/')) return next();
        const filePath = path.join(snapshotDir, url.slice('/snapshot/'.length));
        if (!filePath.startsWith(snapshotDir) || !existsSync(filePath)) return next();
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(readFileSync(filePath));
      });
    },
    closeBundle() {
      if (!existsSync(snapshotDir)) return;
      const outDir = path.resolve(__dirname, 'dist', 'snapshot');
      mkdirSync(outDir, { recursive: true });
      cpSync(snapshotDir, outDir, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), snapshotPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Allow the sandbox/preview host to reach the dev server.
    allowedHosts: true,
    proxy: {
      // In dev, API requests are handled by `npm run dev:api` (wrangler pages dev).
      '/api': 'http://127.0.0.1:8788',
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Function form (Rollup/rolldown-compatible across Vite majors).
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          return undefined;
        },
      },
    },
  },
});
