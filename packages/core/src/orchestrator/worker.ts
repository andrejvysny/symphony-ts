import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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
import { DEFAULT_AGENT_SYSTEM_PROMPT } from '../prompt/system-prompt.js';
import { assertCwdIsWorkspace } from '../workspace/path-safety.js';
import type { IWorkspaceManager } from '../workspace/manager.js';

const execFileAsync = promisify(execFile);

/** Mask obvious secrets (api keys/tokens) in a serialized audit line, plus a known literal secret. */
const SECRET_RE = /(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi;
function redactSecrets(line: string, literal?: string): string {
  let out = line.replace(SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}***`);
  if (literal && literal.length >= 6) out = out.split(literal).join('***');
  return out;
}

/** Best-effort `git status --porcelain` summary for the continuation prompt (capped, never throws). */
async function gitStatusSummary(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      timeout: 5_000,
    });
    return stdout.split('\n').slice(0, 30).join('\n').trimEnd();
  } catch {
    return undefined;
  }
}

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
  | { kind: 'failed'; error: string; category?: ErrorCategory; retryable?: boolean }
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
  /** Seed an existing agent session to resume on turn 1 (resume-on-failure / continuation). */
  resumeSessionId?: string;
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

  // Seed from a carried-over session so turn 1 resumes the agent's prior CLI session.
  let sessionId: string | undefined = ctx.resumeSessionId;
  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (ctx.signal.aborted) return { kind: 'aborted' };
      assertCwdIsWorkspace(ws.path, ws.path);

      let prompt: string;
      if (turn === 1) {
        prompt = promptBuilder.build(issue, ctx.attempt);
      } else {
        const contCtx: { branch?: string; gitStatus?: string } = {};
        if (ws.branch) contCtx.branch = ws.branch;
        const gs = await gitStatusSummary(ws.path);
        if (gs !== undefined) contCtx.gitStatus = gs;
        prompt = promptBuilder.continuation(issue, contCtx);
      }

      const persistLog = config.agent.persist_run_log !== false;
      const auditPath = path.join(config.logs_root, issue.identifier, String(turn), 'events.jsonl');
      if (persistLog)
        await mkdir(path.dirname(auditPath), { recursive: true }).catch(() => undefined);

      const runOpts: RunOptions = {
        prompt,
        cwd: ws.path,
        permissionMode: config.agent.permission_mode,
        signal: ctx.signal,
        timeoutMs: config.agent.turn_timeout_ms,
        idleTimeoutMs: config.agent.idle_timeout_ms,
        settingSources: config.agent.setting_sources,
        strictMcpConfig: config.agent.strict_mcp_config,
        streamPartialMessages: config.agent.stream_partial_messages,
        systemPrompt: config.agent.system_prompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
        issueRef: { id: issue.id, identifier: issue.identifier, title: issue.title },
      };
      if (config.agent.model !== undefined) runOpts.model = config.agent.model;
      if (config.agent.effort !== undefined) runOpts.effort = config.agent.effort;
      // Per-task overrides (set on the ticket) win over the global agent config.
      if (issue.model !== undefined) runOpts.model = issue.model;
      if (issue.effort !== undefined) runOpts.effort = issue.effort;
      if (config.agent.thinking !== undefined) runOpts.thinking = config.agent.thinking;
      if (config.agent.max_budget_usd !== undefined)
        runOpts.maxBudgetUsd = config.agent.max_budget_usd;
      // The agent's own internal step budget (SDK maxTurns). Left unset by default = uncapped, so a
      // single delegation runs to completion; bound only when the operator configures it.
      if (config.agent.max_agent_steps !== undefined)
        runOpts.maxTurns = config.agent.max_agent_steps;
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
        if (persistLog) {
          await appendFile(auditPath, `${redactSecrets(JSON.stringify(ev))}\n`).catch(
            () => undefined,
          );
        }
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
            // A budget stop is a hard cap → never retry, regardless of the classifier.
            retryable:
              turnResult.status === 'error_budget' ? false : (turnResult.retryable ?? true),
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
