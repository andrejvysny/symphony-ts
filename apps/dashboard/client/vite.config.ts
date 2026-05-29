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
    // `vite dev` proxies API calls to a running orchestrator dashboard.
    proxy: { '/api': 'http://127.0.0.1:4500' },
  },
});
