import type { ErrorCategory } from '@symphony/shared';

/** Terminal status of a single backend run (one turn), normalized across agents. */
export type AgentRunStatus =
  | 'success'
  | 'error_max_turns'
  | 'error_execution'
  | 'error_budget'
  | 'blocked';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/** Claude settings layers a run may inherit. `user` = host-global ~/.claude (non-hermetic). */
export type SettingSource = 'user' | 'project' | 'local';

/** MCP wiring passed to a backend. SDK servers run in-process; stdio servers are spawned. */
export interface McpConfig {
  /**
   * Factory for opaque SDK MCP server objects (Claude SDK backend only). Called once
   * per `run()` so each (possibly concurrent) agent gets a FRESH server instance: an
   * SDK MCP `Server` may only be connected to one transport at a time, so sharing one
   * instance across concurrent runs makes the 2nd+ run silently lose its tools.
   */
  sdkServers?: () => Record<string, unknown>;
  /** Stdio MCP server launch specs (CLI backends via --mcp-config). */
  stdioServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

export interface RunOptions {
  /** First turn = full rendered prompt; continuation turns = guidance only. */
  prompt: string;
  /** MUST equal the worktree path; the caller validates before invoking. */
  cwd: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: McpConfig;
  /** Which Claude settings layers to inherit (SDK `settingSources`). Default `['project','local']`. */
  settingSources?: SettingSource[];
  /** CLI: pass `--strict-mcp-config` so only `mcpConfig` servers load (default true → hermetic). */
  strictMcpConfig?: boolean;
  /** Stream partial-message deltas (live text) where the build supports it. Default false. */
  streamPartialMessages?: boolean;
  /** Resume/continue an existing agent session for continuation turns. */
  resumeSessionId?: string;
  /** Used for session/turn titles where the agent supports them. */
  issueRef?: { id: string; identifier: string; title: string };
  /** Orchestrator cancellation (reconcile/stall). */
  signal?: AbortSignal;
  /** Per-turn hard wall-clock timeout (SPEC codex.turn_timeout_ms equivalent). */
  timeoutMs?: number;
  /**
   * Soft idle watchdog: abort the turn if no event is emitted for this long (hung tool / upstream
   * stall). Reset on EVERY event, so long-but-active runs survive. 0/undefined disables. Faster +
   * cleaner than `timeoutMs`; the resulting failure is categorized `idle_timeout` (retryable).
   */
  idleTimeoutMs?: number;
  /**
   * CLI backends only: supervise the run under a tmux session. Presence enables it.
   * `sessionName` is the tmux target (e.g. `symphony-ENG-12`); `logDir` receives the
   * raw `run.jsonl`/`err.log`/`exit.code` files. Ignored by in-process backends.
   */
  tmux?: { sessionName: string; logDir: string };
}

export interface RunResult {
  status: AgentRunStatus;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  numTurns?: number;
  error?: string;
  errorCategory?: ErrorCategory;
  /**
   * Whether this failure is worth retrying (derived by `classify()` from category/signal/text).
   * Absent on success. The orchestrator routes non-retryable failures straight to `blocked`.
   */
  retryable?: boolean;
}

/** Normalized streaming event vocabulary every backend maps onto. */
export type AgentEvent =
  | {
      type: 'session_started';
      sessionId: string;
      threadId?: string;
      turnId?: string;
      pid?: number;
      at: string;
    }
  | { type: 'process_started'; pid?: number; tmuxSession?: string; at: string }
  | { type: 'text_delta'; text: string; at: string }
  | { type: 'tool_use'; toolName: string; toolUseId: string; input: unknown; at: string }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: unknown; at: string }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
      rateLimits?: unknown;
      /** true = absolute thread totals; false = per-turn delta (SPEC §13.5). */
      absolute: boolean;
      at: string;
    }
  | { type: 'turn_completed'; at: string }
  | { type: 'turn_failed'; error: string; category?: ErrorCategory; at: string }
  | { type: 'input_required'; reason: string; at: string }
  | { type: 'result'; result: RunResult; at: string };

/**
 * The single seam that keeps the orchestrator agent-agnostic. `run` yields
 * normalized events for streaming and returns the final `RunResult`.
 */
export interface CodingAgentBackend {
  readonly kind: string;
  run(options: RunOptions): AsyncGenerator<AgentEvent, RunResult, void>;
}

export function nowIso(): string {
  return new Date().toISOString();
}
