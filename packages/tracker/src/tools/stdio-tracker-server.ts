import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PlaneClient } from '../plane/client.js';
import { makePlaneRestExecutor, type ToolResult } from './plane-rest.js';

const TOOL_DESCRIPTION =
  'Run ONE REST call against the configured Plane project using Symphony auth. Paths are ' +
  'relative to this project (e.g. "/states/", "/work-items/{id}/comments/") and cannot leave ' +
  'it. Methods: GET, POST, PATCH.';

/**
 * Build a standalone stdio MCP server exposing `tracker_api`, for CLI agent backends
 * (e.g. `claude-cli`, loaded via `--mcp-config`). Reuses the same transport-neutral executor
 * as the in-process Claude SDK tool, so validation/auth/path-confinement are identical.
 */
export function buildStdioTrackerServer(
  executor: (input: unknown) => Promise<ToolResult>,
): McpServer {
  const server = new McpServer({ name: 'symphony', version: '0.1.0' });
  server.registerTool(
    'tracker_api',
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PATCH']),
        path: z
          .string()
          .describe('Project-relative path, e.g. /states/ or /work-items/{id}/comments/'),
        body: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      const result = await executor(args);
      return {
        content: [{ type: 'text' as const, text: result.output }],
        isError: !result.success,
      };
    },
  );
  return server;
}

/** Entrypoint: env → Plane client → executor → stdio transport. */
async function main(): Promise<void> {
  const apiKey = process.env['PLANE_API_KEY'];
  const endpoint = process.env['PLANE_ENDPOINT'];
  const workspaceSlug = process.env['PLANE_WORKSPACE_SLUG'];
  const projectId = process.env['PLANE_PROJECT_ID'];
  const missing = (
    [
      ['PLANE_API_KEY', apiKey],
      ['PLANE_ENDPOINT', endpoint],
      ['PLANE_WORKSPACE_SLUG', workspaceSlug],
      ['PLANE_PROJECT_ID', projectId],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    process.stderr.write(`stdio-tracker-server: missing ${missing.join(', ')}\n`);
    process.exit(1);
  }
  const client = new PlaneClient({
    endpoint: endpoint!,
    apiKey: apiKey!,
    workspaceSlug: workspaceSlug!,
    projectId: projectId!,
  });
  const executor = makePlaneRestExecutor((m, p, b) => client.request(m, p, b));
  await buildStdioTrackerServer(executor).connect(new StdioServerTransport());
}

// Run only when executed directly (spawned by a CLI backend), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
