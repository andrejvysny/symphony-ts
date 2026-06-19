import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Don't clean: vite writes the Preact SPA to dist/client, and `dev` runs `tsup --watch`.
  // A clean here would delete dist/client and the server would fall back to the legacy HTML.
  // The `build` script does an explicit `pnpm clean` first for reproducible production builds.
  clean: false,
  sourcemap: true,
  target: 'es2022',
  external: ['@symphony/core'],
});
