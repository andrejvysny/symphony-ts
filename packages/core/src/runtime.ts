import { createRequire } from 'node:module';
import {
  buildTrackerSdkMcpServer,
  createBackend,
  type CodingAgentBackend,
  type McpConfig,
} from '@symphony/agent-backends';
import {
  MemoryTracker,
  PlaneClient,
  PlaneTracker,
  makePlaneRestExecutor,
  makePlaneSemanticTools,
  type Tracker,
} from '@symphony/tracker';
import { ConfigError } from '@symphony/shared';
import type { SymphonyConfig } from './config/resolve.js';
import { WorkspaceManager } from './workspace/manager.js';

export function buildTracker(config: SymphonyConfig): Tracker {
  const t = config.tracker;
  if (t.kind === 'memory') {
    return new MemoryTracker({
      activeStates: t.active_states,
      terminalStates: t.terminal_states,
    });
  }
  if (t.kind === 'plane') {
    if (!t.api_key) throw new ConfigError('tracker.api_key required for plane');
    if (!t.endpoint) throw new ConfigError('tracker.endpoint required for plane');
    if (!t.workspace_slug) throw new ConfigError('tracker.workspace_slug required for plane');
    if (!t.project_id) throw new ConfigError('tracker.project_id required for plane');
    return new PlaneTracker({
      endpoint: t.endpoint,
      apiKey: t.api_key,
      workspaceSlug: t.workspace_slug,
      projectId: t.project_id,
      activeStates: t.active_states,
    });
  }
  throw new ConfigError(`unsupported tracker.kind: ${t.kind}`);
}

export function buildBackend(config: SymphonyConfig): CodingAgentBackend {
  return createBackend(
    config.agent.backend,
    config.agent.command !== undefined ? { command: config.agent.command } : {},
  );
}

export function buildWorkspaceManager(config: SymphonyConfig): WorkspaceManager {
  return new WorkspaceManager(config.workspace, config.hooks);
}

/**
 * Build the MCP config exposing the semantic tracker tools (`tracker_get_task`,
 * `tracker_update_status`, `tracker_add_comment`) to the agent — plus the raw `tracker_api`
 * fallback when `agent.allow_raw_tracker_api` is set. The in-process Claude SDK backend gets an
 * SDK MCP server; CLI backends get a stdio server launch spec loaded via `--mcp-config`. Both
 * paths share the same transport-neutral, path-confined executors, so validation/auth are identical.
 */
export function buildMcpConfig(config: SymphonyConfig): McpConfig | undefined {
  const t = config.tracker;
  if (t.kind !== 'plane' || !t.api_key || !t.endpoint || !t.workspace_slug || !t.project_id)
    return undefined;
  const apiKey = t.api_key;
  const endpoint = t.endpoint;
  const workspaceSlug = t.workspace_slug;
  const projectId = t.project_id;
  // States the agent may set: active states + the review/park state, never terminal (commit-only).
  const allowedStates = [...new Set([...t.active_states, t.review_state])];
  const allowRaw = config.agent.allow_raw_tracker_api === true;

  if (config.agent.backend === 'claude-sdk') {
    const client = new PlaneClient({ endpoint, apiKey, workspaceSlug, projectId });
    const tools = makePlaneSemanticTools(client);
    const rawApi = allowRaw
      ? makePlaneRestExecutor((m, p, b) => client.request(m, p, b))
      : undefined;
    // Factory (not a prebuilt instance): the SDK backend rebuilds the server per run so
    // concurrent agents never share one MCP server instance. The executors are stateless.
    return {
      sdkServers: () =>
        buildTrackerSdkMcpServer({ ...tools, allowedStates, ...(rawApi ? { rawApi } : {}) }),
    };
  }

  // CLI backends load MCP servers via `--mcp-config`: spawn the standalone stdio server that
  // exposes the same semantic tracker tools. (Consumed by claude-cli today; codex/opencode flag
  // wiring is a follow-up.)
  const serverPath = createRequire(import.meta.url).resolve(
    '@symphony/tracker/stdio-tracker-server',
  );
  return {
    stdioServers: {
      symphony: {
        command: process.execPath,
        args: [serverPath],
        env: {
          PLANE_API_KEY: apiKey,
          PLANE_ENDPOINT: endpoint,
          PLANE_WORKSPACE_SLUG: workspaceSlug,
          PLANE_PROJECT_ID: projectId,
          PLANE_AGENT_STATES: JSON.stringify(allowedStates),
          ...(allowRaw ? { PLANE_ALLOW_RAW: '1' } : {}),
        },
      },
    },
  };
}
