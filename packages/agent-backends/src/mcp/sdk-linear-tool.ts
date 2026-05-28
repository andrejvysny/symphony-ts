import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface LinearToolResult {
  success: boolean;
  output: string;
}

export type LinearGraphqlExecutor = (input: unknown) => Promise<LinearToolResult>;

/**
 * Build an in-process SDK MCP server exposing `linear_graphql` to the Claude SDK
 * backend. Returns the `mcpServers` map to drop into RunOptions.mcpConfig.sdkServers.
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
