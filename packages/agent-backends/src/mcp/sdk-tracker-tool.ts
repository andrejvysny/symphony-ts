import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface TrackerToolResult {
  success: boolean;
  output: string;
}

export type TrackerApiExecutor = (input: unknown) => Promise<TrackerToolResult>;

const TOOL_DESCRIPTION =
  'Run ONE REST call against the configured Plane project using Symphony auth. Paths are ' +
  'relative to this project (e.g. "/states/", "/work-items/{id}/comments/") and cannot leave ' +
  'it. Methods: GET, POST, PATCH.';

/**
 * Build an in-process SDK MCP server exposing `tracker_api` to the Claude SDK backend.
 * Returns a fresh `mcpServers` map; call it once PER RUN (via the `McpConfig.sdkServers`
 * factory) so concurrent agents never share one server instance.
 */
export function buildTrackerSdkMcpServer(executor: TrackerApiExecutor): Record<string, unknown> {
  const server = createSdkMcpServer({
    name: 'symphony',
    version: '0.1.0',
    tools: [
      tool(
        'tracker_api',
        TOOL_DESCRIPTION,
        {
          method: z.enum(['GET', 'POST', 'PATCH']),
          path: z
            .string()
            .describe('Project-relative path, e.g. /states/ or /work-items/{id}/comments/'),
          body: z.record(z.string(), z.unknown()).optional(),
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
