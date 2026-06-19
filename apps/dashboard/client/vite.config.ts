import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Client build for the Symphony dashboard. Outputs to apps/dashboard/dist/client,
// which the fastify server serves via @fastify/static.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [preact()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    // Pinned so the HMR dev URL is stable/announced (http://localhost:5173).
    port: 5173,
    strictPort: true,
    // `vite dev` proxies API calls (incl. the /api/v1/events + logs SSE streams) to a
    // running orchestrator dashboard on :4500.
    proxy: { '/api': 'http://127.0.0.1:4500' },
  },
});
