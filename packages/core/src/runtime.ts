import {
  buildLinearSdkMcpServer,
  createBackend,
  type CodingAgentBackend,
  type McpConfig,
} from '@symphony/agent-backends';
import {
  LinearClient,
  LinearTracker,
  makeLinearGraphqlExecutor,
  MemoryTracker,
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
  if (t.kind === 'linear') {
    if (!t.api_key) throw new ConfigError('tracker.api_key required for linear');
    if (!t.project_slug) throw new ConfigError('tracker.project_slug required for linear');
    return new LinearTracker({
      endpoint: t.endpoint,
      apiKey: t.api_key,
      projectSlug: t.project_slug,
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
 * Build the MCP config exposing `linear_graphql` to the agent. For the in-process
 * Claude SDK backend this returns an SDK MCP server. (Stdio MCP for CLI backends
 * is a Phase 6 follow-up.)
 */
export function buildMcpConfig(config: SymphonyConfig): McpConfig | undefined {
  if (config.tracker.kind !== 'linear' || !config.tracker.api_key) return undefined;
  const client = new LinearClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.api_key,
  });
  const executor = makeLinearGraphqlExecutor((q, v) => client.graphql(q, v));
  if (config.agent.backend === 'claude-sdk') {
    return { sdkServers: buildLinearSdkMcpServer(executor) };
  }
  return undefined;
}
