import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildStdioTrackerServer, connectBridge } from './stdio-tracker-lib.js';

// Executable entry for the stdio tracker MCP server, spawned by CLI agent backends as
// `node <this file>` (path resolved in core's buildMcpConfig). The self-executing main() guard
// lives ONLY here — never in the importable library — so bundling `@symphony/tracker` into a
// single-file CLI doesn't accidentally run it. Re-export the library so the `@symphony/tracker/
// stdio-tracker-server` subpath keeps its public API.
export * from './stdio-tracker-lib.js';

/** Entrypoint: env → bridge connection → stdio transport. */
async function main(): Promise<void> {
  const socketPath = process.env['SYMPHONY_TRACKER_SOCK'];
  if (!socketPath) {
    process.stderr.write('stdio-tracker-server: missing SYMPHONY_TRACKER_SOCK\n');
    process.exit(1);
  }
  let allowedStates: string[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env['SYMPHONY_AGENT_STATES'] ?? '[]');
    if (Array.isArray(parsed))
      allowedStates = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    allowedStates = [];
  }
  const client = connectBridge(socketPath);
  await buildStdioTrackerServer({ client, allowedStates }).connect(new StdioServerTransport());
}

// Run only when executed directly (spawned by a CLI backend), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
