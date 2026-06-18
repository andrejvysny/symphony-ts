import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface TrackerToolResult {
  success: boolean;
  output: string;
}

export type TrackerApiExecutor = (input: unknown) => Promise<TrackerToolResult>;

/**
 * Executors + the settable-status list the SDK tracker tools wrap. Built in core (`runtime.ts`)
 * from the file tracker and passed in, so this module stays tracker-agnostic (agent-backends does
 * not depend on @symphony/tracker). Descriptions below mirror the canonical ones in
 * @symphony/tracker `file-semantic.ts`.
 */
export interface TrackerSdkToolDeps {
  getTask: TrackerApiExecutor;
  updateStatus: TrackerApiExecutor;
  addComment: TrackerApiExecutor;
  /** Status names the agent may set (active states + the review/park state; terminal excluded). */
  allowedStates: string[];
}

const GET_TASK_DESCRIPTION =
  'Read the full current state of one issue by id: its title, description, current workflow status, ' +
  'and existing comments. Use it first, before any update, to ground yourself in the issue’s live ' +
  'state. It only reads — it does not modify the issue, and it does not return other issues or attachments.';

const UPDATE_STATUS_DESCRIPTION =
  'Set one issue’s workflow status by id. Use it after reading the issue, and only when the target ' +
  'status differs from the current one. It does not post a comment or change the description.';

const ADD_COMMENT_DESCRIPTION =
  'Post one comment to an issue by id. Use it to record your plan on pickup and your evidence-backed ' +
  'summary on completion (what changed, the verification commands you ran and their result, and the ' +
  'commit SHA). It does not change the status.';

/**
 * Build an in-process SDK MCP server exposing the semantic tracker tools (`tracker_get_task`,
 * `tracker_update_status`, `tracker_add_comment`). Returns a fresh `mcpServers` map; call it once
 * PER RUN (via the `McpConfig.sdkServers` factory) so concurrent agents never share one server.
 */
export function buildTrackerSdkMcpServer(deps: TrackerSdkToolDeps): Record<string, unknown> {
  const statusSchema =
    deps.allowedStates.length > 0
      ? z.enum(deps.allowedStates as [string, ...string[]])
      : z.string();

  const server = createSdkMcpServer({
    name: 'symphony',
    version: '0.1.0',
    tools: [
      tool(
        'tracker_get_task',
        GET_TASK_DESCRIPTION,
        { task_id: z.string().describe('The issue id (issue.id).') },
        async (args) => {
          const r = await deps.getTask(args);
          return { content: [{ type: 'text', text: r.output }], isError: !r.success };
        },
      ),
      tool(
        'tracker_update_status',
        UPDATE_STATUS_DESCRIPTION,
        {
          task_id: z.string().describe('The issue id (issue.id).'),
          status: statusSchema.describe('Target workflow state name.'),
        },
        async (args) => {
          const r = await deps.updateStatus(args);
          return { content: [{ type: 'text', text: r.output }], isError: !r.success };
        },
      ),
      tool(
        'tracker_add_comment',
        ADD_COMMENT_DESCRIPTION,
        {
          task_id: z.string().describe('The issue id (issue.id).'),
          body: z.string().describe('Comment body (plain text or simple HTML).'),
        },
        async (args) => {
          const r = await deps.addComment(args);
          return { content: [{ type: 'text', text: r.output }], isError: !r.success };
        },
      ),
    ],
  });
  return { symphony: server };
}
