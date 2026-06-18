import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  buildTrackerSdkMcpServer,
  createBackend,
  type CodingAgentBackend,
  type McpConfig,
} from '@symphony/agent-backends';
import {
  FileTracker,
  type FileTrackerOptions,
  makeFileSemanticTools,
  MemoryTracker,
  type Tracker,
} from '@symphony/tracker';
import { ConfigError } from '@symphony/shared';
import type { SymphonyConfig } from './config/resolve.js';
import { WorkspaceManager } from './workspace/manager.js';

/** Resolve the file store root (resolve.ts always sets data_root; guard for direct callers). */
function dataRootOf(config: SymphonyConfig): string {
  return config.tracker.data_root ?? path.join(os.homedir(), '.symphony');
}

/** The Unix-socket path the tracker bridge listens on (CLI agents connect here). */
export function trackerSocketPath(config: SymphonyConfig): string {
  return path.join(dataRootOf(config), 'tracker.sock');
}

/** Derive FileTracker options for the active project from the resolved config + project registry. */
export function fileTrackerOptions(config: SymphonyConfig): FileTrackerOptions {
  const t = config.tracker;
  const projectKey = t.project_id ?? 'default';
  const entry = config.projects.find((p) => p.project_id === projectKey);
  return {
    dataRoot: dataRootOf(config),
    projectKey,
    identifier: entry?.identifier ?? 'SYM',
    activeStates: t.active_states,
    terminalStates: t.terminal_states,
    reviewState: t.review_state,
  };
}

/** States the agent may set: active states + the review/park state, never terminal (commit-only). */
function allowedStatesOf(config: SymphonyConfig): string[] {
  return [...new Set([...config.tracker.active_states, config.tracker.review_state])];
}

export function buildTracker(config: SymphonyConfig): Tracker {
  const t = config.tracker;
  if (t.kind === 'file') {
    return new FileTracker(fileTrackerOptions(config));
  }
  if (t.kind === 'memory') {
    return new MemoryTracker({
      activeStates: t.active_states,
      terminalStates: t.terminal_states,
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
 * `tracker_update_status`, `tracker_add_comment`) to the agent. The in-process Claude SDK backend
 * gets an SDK MCP server with in-process executors over a FileTracker; CLI backends get a stdio
 * bridge-client launch spec (loaded via `--mcp-config`) that proxies to the orchestrator's
 * Unix-socket bridge — keeping the orchestrator the single writer of the file store.
 */
export function buildMcpConfig(config: SymphonyConfig): McpConfig | undefined {
  const t = config.tracker;
  if (t.kind !== 'file') return undefined;

  const allowedStates = allowedStatesOf(config);
  if (config.agent.backend === 'claude-sdk') {
    const tracker = new FileTracker(fileTrackerOptions(config));
    const tools = makeFileSemanticTools(tracker, allowedStates);
    return { sdkServers: () => buildTrackerSdkMcpServer({ ...tools, allowedStates }) };
  }
  const stdioPath = createRequire(import.meta.url).resolve(
    '@symphony/tracker/stdio-tracker-server',
  );
  return {
    stdioServers: {
      symphony: {
        command: process.execPath,
        args: [stdioPath],
        env: {
          SYMPHONY_TRACKER_SOCK: trackerSocketPath(config),
          SYMPHONY_AGENT_STATES: JSON.stringify(allowedStates),
        },
      },
    },
  };
}
