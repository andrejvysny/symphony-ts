import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LinearClient } from '../linear/client.js';
import { makeLinearGraphqlExecutor, type ToolResult } from './linear-graphql.js';

/**
 * Build a standalone stdio MCP server exposing `linear_graphql`, for CLI agent backends
 * (e.g. `claude-cli`, loaded via `--mcp-config`). Reuses the same transport-neutral
 * executor as the in-process Claude SDK tool, so the validation/auth path is identical.
 */
export function buildStdioLinearServer(
  executor: (input: unknown) => Promise<ToolResult>,
): McpServer {
  const server = new McpServer({ name: 'symphony', version: '0.1.0' });
  server.registerTool(
    'linear_graphql',
    {
      description:
        'Execute a single raw GraphQL query or mutation against Linear using Symphony auth.',
      inputSchema: {
        query: z.string().describe('A single GraphQL operation document.'),
        variables: z.record(z.string(), z.unknown()).optional(),
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

/** Entrypoint: env → Linear client → executor → stdio transport. */
async function main(): Promise<void> {
  const apiKey = process.env['LINEAR_API_KEY'];
  const endpoint = process.env['SYMPHONY_LINEAR_ENDPOINT'] ?? 'https://api.linear.app/graphql';
  if (!apiKey) {
    process.stderr.write('stdio-linear-server: LINEAR_API_KEY is not set\n');
    process.exit(1);
  }
  const client = new LinearClient({ endpoint, apiKey });
  const executor = makeLinearGraphqlExecutor((q, v) => client.graphql(q, v));
  await buildStdioLinearServer(executor).connect(new StdioServerTransport());
}

// Run only when executed directly (spawned by a CLI backend), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
