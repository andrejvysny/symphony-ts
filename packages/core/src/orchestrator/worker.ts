import path from 'node:path';
import type {
  AgentEvent,
  CodingAgentBackend,
  McpConfig,
  RunOptions,
  RunResult,
} from '@symphony/agent-backends';
import type { ErrorCategory, NormalizedIssue } from '@symphony/shared';
import type { Tracker } from '@symphony/tracker';
import type { SymphonyConfig } from '../config/resolve.js';
import { PromptBuilder } from '../prompt/builder.js';
import { assertCwdIsWorkspace } from '../workspace/path-safety.js';
import type { IWorkspaceManager } from '../workspace/manager.js';

/**
 * Why a worker's turn loop ended cleanly:
 * - `terminal`   — the issue reached a terminal state (clean up, do not continue)
 * - `nonactive`  — the issue left active without going terminal (release, preserve workspace)
 * - `exhausted`  — still active with turns spent (continuation re-dispatch warranted)
 */
export type CompletedDisposition = 'terminal' | 'nonactive' | 'exhausted';

export type WorkerOutcome =
  | { kind: 'completed'; disposition: CompletedDisposition }
  | { kind: 'blocked'; reason: string }
  | { kind: 'failed'; error: string; category?: ErrorCategory }
  | { kind: 'aborted' };

export interface WorkerDeps {
  tracker: Tracker;
  workspaceManager: IWorkspaceManager;
  promptBuilder: PromptBuilder;
  backend: CodingAgentBackend;
  config: SymphonyConfig;
  mcpConfig?: McpConfig;
}

export interface WorkerContext {
  issue: NormalizedIssue;
  attempt: number | null;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  onSession: (sessionId: string) => void;
  onWorktree: (path: string) => void;
  onProcess: (info: { pid?: number; tmuxSession?: string }) => void;
}

/**
 * Run one issue end-to-end: workspace → before_run → turn loop (≤ max_turns) →
 * after_run. Mirrors the Elixir AgentRunner + SPEC §7.1 continuation semantics.
 */
export async function runWorker(deps: WorkerDeps, ctx: WorkerContext): Promise<WorkerOutcome> {
  const { tracker, workspaceManager, promptBuilder, backend, config } = deps;
  const { issue } = ctx;
  const activeStates = new Set(config.tracker.active_states);
  const terminalStates = new Set(config.tracker.terminal_states);
  const maxTurns = config.agent.max_turns;

  let ws;
  try {
    ws = await workspaceManager.createForIssue(issue);
  } catch (e) {
    return { kind: 'failed', error: `workspace creation failed: ${(e as Error).message}` };
  }
  ctx.onWorktree(ws.path);

  const before = await workspaceManager.runBeforeRun(issue, ws);
  if (!before.ok) return { kind: 'failed', error: `before_run hook failed: ${before.error ?? ''}` };

  let sessionId: string | undefined;
  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (ctx.signal.aborted) return { kind: 'aborted' };
      assertCwdIsWorkspace(ws.path, ws.path);

      const prompt =
        turn === 1
          ? promptBuilder.build(issue, ctx.attempt)
          : promptBuilder.continuation(issue, turn, maxTurns);

      const runOpts: RunOptions = {
        prompt,
        cwd: ws.path,
        permissionMode: config.agent.permission_mode,
        signal: ctx.signal,
        timeoutMs: config.agent.turn_timeout_ms,
        issueRef: { id: issue.id, identifier: issue.identifier, title: issue.title },
      };
      if (config.agent.model !== undefined) runOpts.model = config.agent.model;
      if (config.agent.max_budget_usd !== undefined)
        runOpts.maxBudgetUsd = config.agent.max_budget_usd;
      if (config.agent.allowed_tools !== undefined)
        runOpts.allowedTools = config.agent.allowed_tools;
      if (config.agent.disallowed_tools !== undefined)
        runOpts.disallowedTools = config.agent.disallowed_tools;
      if (deps.mcpConfig !== undefined) runOpts.mcpConfig = deps.mcpConfig;
      if (sessionId !== undefined) runOpts.resumeSessionId = sessionId;
      // tmux supervision applies to CLI subprocess backends only; the in-process
      // claude-sdk backend has no subprocess to attach/log/kill.
      if (config.agent.tmux && config.agent.backend !== 'claude-sdk') {
        runOpts.tmux = {
          sessionName: `symphony-${issue.identifier}`,
          logDir: path.join(config.logs_root, issue.identifier, String(turn)),
        };
      }

      let turnResult: RunResult | undefined;
      for await (const ev of backend.run(runOpts)) {
        ctx.emit(ev);
        if (ev.type === 'session_started') {
          sessionId = ev.sessionId;
          ctx.onSession(ev.sessionId);
        } else if (ev.type === 'process_started') {
          ctx.onProcess({
            ...(ev.pid !== undefined ? { pid: ev.pid } : {}),
            ...(ev.tmuxSession !== undefined ? { tmuxSession: ev.tmuxSession } : {}),
          });
        } else if (ev.type === 'result') {
          turnResult = ev.result;
        }
      }

      if (ctx.signal.aborted) return { kind: 'aborted' };
      if (!turnResult) return { kind: 'failed', error: 'backend produced no result' };
      if (turnResult.sessionId) sessionId = turnResult.sessionId;

      switch (turnResult.status) {
        case 'blocked':
          return { kind: 'blocked', reason: turnResult.error ?? 'operator input required' };
        case 'error_max_turns':
        case 'error_execution':
        case 'error_budget':
          return {
            kind: 'failed',
            error: turnResult.error ?? turnResult.status,
            ...(turnResult.errorCategory !== undefined
              ? { category: turnResult.errorCategory }
              : {}),
          };
        case 'success': {
          let refs;
          try {
            refs = await tracker.fetchIssueStatesByIds([issue.id]);
          } catch (e) {
            return { kind: 'failed', error: `state refresh failed: ${(e as Error).message}` };
          }
          const ref = refs.find((r) => r.id === issue.id);
          if (!ref || !activeStates.has(ref.state)) {
            const disposition = ref && terminalStates.has(ref.state) ? 'terminal' : 'nonactive';
            return { kind: 'completed', disposition };
          }
          if (turn >= maxTurns) return { kind: 'completed', disposition: 'exhausted' };
          // still active and turns remain → continuation turn
          break;
        }
      }
    }
    return { kind: 'completed', disposition: 'exhausted' };
  } finally {
    await workspaceManager.runAfterRun(issue, ws).catch(() => undefined);
  }
}
