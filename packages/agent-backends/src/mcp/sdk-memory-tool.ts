import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface MemoryToolResult {
  success: boolean;
  output: string;
}

export type MemoryToolExecutor = (input: unknown) => Promise<MemoryToolResult>;

/**
 * Build an in-process SDK MCP server for the OFFLINE dry-run (no Linear): exposes
 * `set_issue_state` + `add_comment` so a real Claude agent can park its MemoryTracker
 * ticket, mirroring the live `linear_graphql` state move. Returns a FRESH server map;
 * call once PER RUN (via the `McpConfig.sdkServers` factory) so concurrent agents never
 * share one server instance.
 */
export function buildMemorySdkMcpServer(
  setIssueState: MemoryToolExecutor,
  addComment: MemoryToolExecutor,
): Record<string, unknown> {
  const server = createSdkMcpServer({
    name: 'symphony',
    version: '0.1.0',
    tools: [
      tool(
        'set_issue_state',
        'Move an issue to a new workflow state by its tracker id.',
        {
          issueId: z.string().describe('The tracker issue id (issue.id).'),
          state: z.string().describe('Target workflow state name, e.g. "Human Review".'),
        },
        async (args) => {
          const result = await setIssueState(args);
          return { content: [{ type: 'text', text: result.output }], isError: !result.success };
        },
      ),
      tool(
        'add_comment',
        'Post a comment on an issue by its tracker id.',
        {
          issueId: z.string().describe('The tracker issue id (issue.id).'),
          body: z.string().describe('Comment body (markdown).'),
        },
        async (args) => {
          const result = await addComment(args);
          return { content: [{ type: 'text', text: result.output }], isError: !result.success };
        },
      ),
    ],
  });
  return { symphony: server };
}
