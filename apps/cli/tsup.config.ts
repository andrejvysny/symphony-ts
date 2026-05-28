import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  banner: { js: '#!/usr/bin/env node' },
  external: ['@symphony/shared', '@symphony/tracker', '@symphony/agent-backends', '@symphony/core'],
});
