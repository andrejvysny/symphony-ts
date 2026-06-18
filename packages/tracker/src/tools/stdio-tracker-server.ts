import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  TRACKER_ADD_COMMENT_DESCRIPTION,
  TRACKER_GET_TASK_DESCRIPTION,
  TRACKER_UPDATE_STATUS_DESCRIPTION,
  type ToolResult,
} from './file-semantic.js';

/** A thin RPC client to the orchestrator's tracker bridge (one call per tool invocation). */
export interface BridgeClient {
  call(tool: string, input: unknown): Promise<ToolResult>;
}

export interface TrackerStdioToolDeps {
  client: BridgeClient;
  /** Status names the agent may set (drives the `status` enum). */
  allowedStates: string[];
}

/**
 * Connect to the orchestrator's Unix-socket tracker bridge. Requests/responses are newline-delimited
 * JSON; responses are matched to requests by a monotonic id. A dropped connection rejects all
 * in-flight calls so the agent gets a clear error rather than hanging.
 */
export function connectBridge(socketPath: string): BridgeClient & { close: () => void } {
  const sock = net.createConnection(socketPath);
  sock.setEncoding('utf8');
  const pending = new Map<number, (r: ToolResult) => void>();
  let nextId = 0;
  let buf = '';

  sock.on('data', (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length === 0) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: ToolResult };
        const cb = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
        if (cb && msg.result) {
          pending.delete(msg.id as number);
          cb(msg.result);
        }
      } catch {
        // ignore malformed line
      }
    }
  });
  const failAll = (message: string): void => {
    for (const [id, cb] of pending) {
      pending.delete(id);
      cb({ success: false, output: JSON.stringify({ error: message }) });
    }
  };
  sock.on('error', () => failAll('tracker bridge connection error'));
  sock.on('close', () => failAll('tracker bridge connection closed'));

  return {
    call(tool, input) {
      return new Promise<ToolResult>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        sock.write(`${JSON.stringify({ id, tool, input })}\n`);
      });
    },
    close() {
      sock.end();
    },
  };
}

/**
 * Build a standalone stdio MCP server exposing the semantic tracker tools (`tracker_get_task`,
 * `tracker_update_status`, `tracker_add_comment`) for CLI agent backends (loaded via `--mcp-config`).
 * Every tool call is proxied to the orchestrator's tracker bridge, keeping the orchestrator the
 * single writer of the file store.
 */
export function buildStdioTrackerServer(deps: TrackerStdioToolDeps): McpServer {
  const server = new McpServer({ name: 'symphony', version: '0.1.0' });
  const statusSchema =
    deps.allowedStates.length > 0
      ? z.enum(deps.allowedStates as [string, ...string[]])
      : z.string();
  const proxy = (tool: string) => async (args: unknown) => {
    const r = await deps.client.call(tool, args);
    return { content: [{ type: 'text' as const, text: r.output }], isError: !r.success };
  };

  server.registerTool(
    'tracker_get_task',
    {
      description: TRACKER_GET_TASK_DESCRIPTION,
      inputSchema: { task_id: z.string().describe('The issue id (issue.id).') },
    },
    proxy('tracker_get_task'),
  );
  server.registerTool(
    'tracker_update_status',
    {
      description: TRACKER_UPDATE_STATUS_DESCRIPTION,
      inputSchema: {
        task_id: z.string().describe('The issue id (issue.id).'),
        status: statusSchema.describe('Target workflow state name.'),
      },
    },
    proxy('tracker_update_status'),
  );
  server.registerTool(
    'tracker_add_comment',
    {
      description: TRACKER_ADD_COMMENT_DESCRIPTION,
      inputSchema: {
        task_id: z.string().describe('The issue id (issue.id).'),
        body: z.string().describe('Comment body (plain text).'),
      },
    },
    proxy('tracker_add_comment'),
  );
  return server;
}

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
