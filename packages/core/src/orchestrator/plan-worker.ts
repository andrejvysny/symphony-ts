import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentEvent,
  CodingAgentBackend,
  McpConfig,
  RunOptions,
  RunResult,
} from '@symphony/agent-backends';
import type { ErrorCategory, NormalizedIssue } from '@symphony/shared';
import type { SymphonyConfig } from '../config/resolve.js';
import { DEFAULT_PLAN_SYSTEM_PROMPT } from '../prompt/plan-prompt.js';
import { assertCwdIsWorkspace } from '../workspace/path-safety.js';
import type { IWorkspaceManager } from '../workspace/manager.js';
import { redactSecrets } from './worker.js';

/**
 * Shared control object between a plan run's MCP tool executors (in the orchestrator) and its worker:
 * the executors flip these flags so the worker can classify the outcome after the run ends.
 */
export interface PlanRunControl {
  /** `symphony_submit_plan` ran → the plan markdown is persisted, the run can end cleanly. */
  submitted: boolean;
  /** `symphony_ask` ran in pause mode → the run was parked for operator input (resumable). */
  parkedAskId: string | null;
}

export interface PlanWorkerDeps {
  workspaceManager: IWorkspaceManager;
  backend: CodingAgentBackend;
  config: SymphonyConfig;
  /** Plan-mode MCP server (symphony_ask + symphony_submit_plan), built per run by the orchestrator. */
  mcpConfig: McpConfig;
}

export interface PlanWorkerContext {
  issue: NormalizedIssue;
  /** Fully-rendered first-turn prompt (initial / pause-resume answers / revision). */
  prompt: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  onSession: (sessionId: string) => void;
  onWorktree: (path: string) => void;
  control: PlanRunControl;
  /** Resume an existing agent session (pause-mode answer continuation / revision). */
  resumeSessionId?: string;
}

export type PlanOutcome =
  | { kind: 'ready' }
  | { kind: 'parked'; askId: string }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: string; category?: ErrorCategory };

/**
 * Run one read-only PLAN session end-to-end: read-only workspace → a single `permissionMode:'plan'`
 * backend run → classify the outcome. Unlike {@link runWorker} there is no turn loop, no continuation,
 * and no tracker state refresh — the plan agent never moves the ticket. The plan + Q&A are persisted by
 * the orchestrator's MCP tool executors (closures over {@link PlanWorkerContext.control}); this worker
 * only streams events, captures the session id, and reports how the run ended. It never `integrate`s
 * (read-only); the workspace is cleaned up on exit.
 */
export async function runPlanWorker(
  deps: PlanWorkerDeps,
  ctx: PlanWorkerContext,
): Promise<PlanOutcome> {
  const { workspaceManager, backend, config } = deps;
  const { issue } = ctx;

  let ws;
  try {
    ws = await workspaceManager.createForIssue(issue);
  } catch (e) {
    return { kind: 'failed', error: `workspace creation failed: ${(e as Error).message}` };
  }
  ctx.onWorktree(ws.path);

  try {
    if (ctx.signal.aborted) return { kind: 'aborted' };
    assertCwdIsWorkspace(ws.path, ws.path);

    const persistLog = config.agent.persist_run_log !== false;
    const auditPath = path.join(config.logs_root, issue.identifier, 'plan', 'events.jsonl');
    if (persistLog)
      await mkdir(path.dirname(auditPath), { recursive: true }).catch(() => undefined);

    const runOpts: RunOptions = {
      prompt: ctx.prompt,
      cwd: ws.path,
      // Force read-only planning regardless of the global agent.permission_mode.
      permissionMode: 'plan',
      signal: ctx.signal,
      // Plan runs wait on the operator: no idle/turn auto-kill (cancel is operator-driven; the SDK
      // budget still bounds spend). The idle watchdog would otherwise fire while a question is pending.
      idleTimeoutMs: 0,
      settingSources: config.agent.setting_sources,
      strictMcpConfig: config.agent.strict_mcp_config,
      streamPartialMessages: config.agent.stream_partial_messages,
      systemPrompt: config.plan.system_prompt ?? DEFAULT_PLAN_SYSTEM_PROMPT,
      mcpConfig: deps.mcpConfig,
      issueRef: { id: issue.id, identifier: issue.identifier, title: issue.title },
    };
    // Plan defaults are stronger than execution; a per-ticket model/effort override still wins.
    const model = issue.model ?? config.plan.model ?? config.agent.model;
    if (model !== undefined) runOpts.model = model;
    runOpts.effort = issue.effort ?? config.plan.effort;
    runOpts.thinking = config.plan.thinking;
    if (config.agent.max_budget_usd !== undefined)
      runOpts.maxBudgetUsd = config.agent.max_budget_usd;
    if (ctx.resumeSessionId !== undefined) runOpts.resumeSessionId = ctx.resumeSessionId;

    let result: RunResult | undefined;
    for await (const ev of backend.run(runOpts)) {
      ctx.emit(ev);
      if (persistLog) {
        await appendFile(auditPath, `${redactSecrets(JSON.stringify(ev))}\n`).catch(
          () => undefined,
        );
      }
      if (ev.type === 'session_started') ctx.onSession(ev.sessionId);
      else if (ev.type === 'result') result = ev.result;
    }

    // The MCP executors flip control flags as they run; check them before the abort/error signals,
    // since submit/park both end the run via a deliberate abort.
    if (ctx.control.submitted) return { kind: 'ready' };
    if (ctx.control.parkedAskId !== null) return { kind: 'parked', askId: ctx.control.parkedAskId };
    if (ctx.signal.aborted) return { kind: 'aborted' };
    if (
      result &&
      (result.status === 'error_execution' ||
        result.status === 'error_budget' ||
        result.status === 'error_max_turns')
    ) {
      return {
        kind: 'failed',
        error: result.error ?? result.status,
        ...(result.errorCategory !== undefined ? { category: result.errorCategory } : {}),
      };
    }
    // Natural end without a submitted plan: the agent stopped without delivering one.
    return { kind: 'failed', error: 'planning ended without a submitted plan' };
  } finally {
    // Read-only run: never integrate/merge. Clean up the throwaway worktree (single_dir is a no-op).
    await workspaceManager.cleanup(issue).catch(() => undefined);
  }
}
