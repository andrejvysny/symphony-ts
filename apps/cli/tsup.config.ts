import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// Dashboard's vite-built Preact client (apps/dashboard/dist/client) → copied next to the bundle.
const clientSrc = fileURLToPath(new URL('../dashboard/dist/client', import.meta.url));
const clientDest = fileURLToPath(new URL('./dist/client', import.meta.url));
// Annotated config reference → shipped next to the bundle for offline discovery.
const exampleSrc = fileURLToPath(new URL('../../WORKFLOW.md.example', import.meta.url));
const exampleDest = fileURLToPath(new URL('./dist/WORKFLOW.md.example', import.meta.url));

export default defineConfig({
  // Outputs: the bin launcher (cli — checks Node version, then dynamically imports main), the real
  // entry (main), and the stdio tracker MCP server that CLI agent backends spawn.
  entry: {
    cli: 'src/cli.ts',
    main: 'src/main.ts',
    'stdio-tracker-server': 'src/stdio-tracker-server.ts',
  },
  format: ['esm'],
  dts: false,
  clean: true,
  // No code-splitting: keep each entry standalone. The stdio server's `import.meta.url === argv[1]`
  // self-exec guard must live in the spawned file itself, not a shared chunk, or it never fires.
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  banner: { js: '#!/usr/bin/env node' },
  // Inline the internal workspace packages so the published CLI is self-contained (one npm
  // package). Third-party deps stay external and are declared in package.json `dependencies`
  // (notably pino/pino-pretty, which load transports in worker threads and must not be bundled).
  noExternal: [/^@symphony\//],
  // The dashboard server resolves its client via `new URL('./client', import.meta.url)`
  // (apps/dashboard/src/server.ts); once everything is collapsed into dist/main.js that points at
  // dist/client, so place the built client there. No-op in dev if the client hasn't been built.
  async onSuccess() {
    if (existsSync(clientSrc)) cpSync(clientSrc, clientDest, { recursive: true });
    if (existsSync(exampleSrc)) cpSync(exampleSrc, exampleDest);
  },
});
