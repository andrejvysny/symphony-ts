// Bundled entry for the published single-file CLI: tsup emits this as dist/stdio-tracker-server.js
// next to dist/main.js. CLI agent backends (codex/opencode) spawn it via
// `node dist/stdio-tracker-server.js` (see runtime.ts buildMcpConfig). The imported module
// self-executes only when run directly (its `import.meta.url === argv[1]` main guard), so importing
// it here is just a bundling shim and has no effect at import time.
import '@symphony/tracker/stdio-tracker-server';
