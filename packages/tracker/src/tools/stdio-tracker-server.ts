import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PlaneClient } from '../plane/client.js';
import { makePlaneRestExecutor } from './plane-rest.js';
import {
  makePlaneSemanticTools,
  TRACKER_ADD_COMMENT_DESCRIPTION,
  TRACKER_GET_TASK_DESCRIPTION,
  TRACKER_UPDATE_STATUS_DESCRIPTION,
  type PlaneSemanticTools,
  type TrackerExecutor,
} from './plane-semantic.js';

const RAW_API_DESCRIPTION =
  'Run ONE raw REST call against the configured Plane project (advanced fallback — prefer ' +
  'tracker_get_task, tracker_update_status, and tracker_add_comment). Paths are project-relative ' +
  '(e.g. /work-items/{id}/). Methods: GET, POST, PATCH.';

/** Executors + settable-status list the stdio tracker tools wrap (parity with the SDK server). */
export interface TrackerStdioToolDeps extends PlaneSemanticTools {
  allowedStates: string[];
  rawApi?: TrackerExecutor;
}

/**
 * Build a standalone stdio MCP server exposing the semantic tracker tools (`tracker_get_task`,
 * `tracker_update_status`, `tracker_add_comment`) — plus the raw `tracker_api` fallback when
 * enabled — for CLI agent backends (e.g. `claude-cli`, loaded via `--mcp-config`). Reuses the
 * same executors as the in-process Claude SDK tools, so validation/auth/path-confinement match.
 */
export function buildStdioTrackerServer(deps: TrackerStdioToolDeps): McpServer {
  const server = new McpServer({ name: 'symphony', version: '0.1.0' });
  const statusSchema =
    deps.allowedStates.length > 0
      ? z.enum(deps.allowedStates as [string, ...string[]])
      : z.string();

  server.registerTool(
    'tracker_get_task',
    {
      description: TRACKER_GET_TASK_DESCRIPTION,
      inputSchema: { task_id: z.string().describe('The Plane issue id (issue.id).') },
    },
    async (args) => {
      const r = await deps.getTask(args);
      return { content: [{ type: 'text' as const, text: r.output }], isError: !r.success };
    },
  );

  server.registerTool(
    'tracker_update_status',
    {
      description: TRACKER_UPDATE_STATUS_DESCRIPTION,
      inputSchema: {
        task_id: z.string().describe('The Plane issue id (issue.id).'),
        status: statusSchema.describe('Target workflow state name.'),
      },
    },
    async (args) => {
      const r = await deps.updateStatus(args);
      return { content: [{ type: 'text' as const, text: r.output }], isError: !r.success };
    },
  );

  server.registerTool(
    'tracker_add_comment',
    {
      description: TRACKER_ADD_COMMENT_DESCRIPTION,
      inputSchema: {
        task_id: z.string().describe('The Plane issue id (issue.id).'),
        body: z.string().describe('Comment body (plain text or simple HTML).'),
      },
    },
    async (args) => {
      const r = await deps.addComment(args);
      return { content: [{ type: 'text' as const, text: r.output }], isError: !r.success };
    },
  );

  if (deps.rawApi) {
    const rawApi = deps.rawApi;
    server.registerTool(
      'tracker_api',
      {
        description: RAW_API_DESCRIPTION,
        inputSchema: {
          method: z.enum(['GET', 'POST', 'PATCH']),
          path: z.string().describe('Project-relative path, e.g. /work-items/{id}/.'),
          body: z.record(z.string(), z.unknown()).optional(),
        },
      },
      async (args) => {
        const r = await rawApi(args);
        return { content: [{ type: 'text' as const, text: r.output }], isError: !r.success };
      },
    );
  }

  return server;
}

/** Entrypoint: env → Plane client → semantic executors → stdio transport. */
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

  let allowedStates: string[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env['PLANE_AGENT_STATES'] ?? '[]');
    if (Array.isArray(parsed))
      allowedStates = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    allowedStates = [];
  }
  const allowRaw = process.env['PLANE_ALLOW_RAW'] === '1';

  const tools = makePlaneSemanticTools(client);
  const deps: TrackerStdioToolDeps = {
    ...tools,
    allowedStates,
    ...(allowRaw ? { rawApi: makePlaneRestExecutor((m, p, b) => client.request(m, p, b)) } : {}),
  };
  await buildStdioTrackerServer(deps).connect(new StdioServerTransport());
}

// Run only when executed directly (spawned by a CLI backend), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
