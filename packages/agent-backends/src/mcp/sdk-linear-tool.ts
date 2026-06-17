import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface LinearToolResult {
  success: boolean;
  output: string;
}

export type LinearGraphqlExecutor = (input: unknown) => Promise<LinearToolResult>;

/**
 * Build an in-process SDK MCP server exposing `linear_graphql` to the Claude SDK
 * backend. Returns a fresh `mcpServers` map; call it once PER RUN (via the
 * `McpConfig.sdkServers` factory) so concurrent agents never share one server instance.
 */
export function buildLinearSdkMcpServer(executor: LinearGraphqlExecutor): Record<string, unknown> {
  const server = createSdkMcpServer({
    name: 'symphony',
    version: '0.1.0',
    tools: [
      tool(
        'linear_graphql',
        'Execute a raw GraphQL query or mutation against Linear using Symphony auth.',
        {
          query: z.string().describe('A single GraphQL operation document.'),
          variables: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => {
          const result = await executor(args);
          return {
            content: [{ type: 'text', text: result.output }],
            isError: !result.success,
          };
        },
      ),
    ],
  });
  return { symphony: server };
}
