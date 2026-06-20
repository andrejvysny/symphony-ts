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
import { DEFAULT_ORDER_SYSTEM_PROMPT } from '../prompt/order-prompt.js';
import { assertCwdIsWorkspace } from '../workspace/path-safety.js';
import type { IWorkspaceManager } from '../workspace/manager.js';
import { redactSecrets } from './worker.js';

/**
 * Shared control object between an ordering run's MCP tool executors (in the orchestrator) and its
 * worker: the executors flip these flags so the worker can classify the outcome after the run ends.
 * Mirrors {@link PlanRunControl}.
 */
export interface OrderRunControl {
  /** `symphony_submit_order` ran with a valid order → persisted, the run can end cleanly. */
  submitted: boolean;
  /** `symphony_ask` ran in pause mode → the run was parked for operator input (resumable). */
  parkedAskId: string | null;
}

export interface OrderWorkerDeps {
  workspaceManager: IWorkspaceManager;
  backend: CodingAgentBackend;
  config: SymphonyConfig;
  /** Order-mode MCP server (symphony_ask + symphony_submit_order), built per run by the orchestrator. */
  mcpConfig: McpConfig;
}

export interface OrderWorkerContext {
  runId: string;
  /**
   * One selected issue used to create the read-only workspace (an ordering run reads the whole repo,
   * so which selected ticket's checkout it runs in is immaterial; single_dir uses the repo dir).
   */
  anchorIssue: NormalizedIssue;
  /** Fully-rendered first-turn prompt (initial / pause-resume answers). */
  prompt: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  onSession: (sessionId: string) => void;
  onWorktree: (path: string) => void;
  control: OrderRunControl;
  /** Resume an existing agent session (pause-mode answer continuation / re-run). */
  resumeSessionId?: string;
}

export type OrderOutcome =
  | { kind: 'ready' }
  | { kind: 'parked'; askId: string }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: string; category?: ErrorCategory };

/**
 * Run one read-only ORDERING session end-to-end: read-only workspace → a single `permissionMode:'plan'`
 * backend run → classify the outcome. Like {@link runPlanWorker} there is no turn loop and no tracker
 * state change — the agent only proposes an order. The proposal + Q&A are persisted by the
 * orchestrator's MCP tool executors (closures over {@link OrderWorkerContext.control}); this worker
 * streams events, captures the session id, and reports how the run ended. It never integrates; the
 * workspace is cleaned up on exit.
 */
export async function runOrderWorker(
  deps: OrderWorkerDeps,
  ctx: OrderWorkerContext,
): Promise<OrderOutcome> {
  const { workspaceManager, backend, config } = deps;
  const { anchorIssue } = ctx;

  let ws;
  try {
    ws = await workspaceManager.createForIssue(anchorIssue);
  } catch (e) {
    return { kind: 'failed', error: `workspace creation failed: ${(e as Error).message}` };
  }
  ctx.onWorktree(ws.path);

  try {
    if (ctx.signal.aborted) return { kind: 'aborted' };
    assertCwdIsWorkspace(ws.path, ws.path);

    const persistLog = config.agent.persist_run_log !== false;
    const auditPath = path.join(config.logs_root, 'orders', ctx.runId, 'events.jsonl');
    if (persistLog)
      await mkdir(path.dirname(auditPath), { recursive: true }).catch(() => undefined);

    const runOpts: RunOptions = {
      prompt: ctx.prompt,
      cwd: ws.path,
      // Force read-only analysis regardless of the global agent.permission_mode.
      permissionMode: 'plan',
      signal: ctx.signal,
      // Operator-driven: no idle/turn auto-kill (the SDK budget still bounds spend).
      idleTimeoutMs: 0,
      settingSources: config.agent.setting_sources,
      strictMcpConfig: config.agent.strict_mcp_config,
      streamPartialMessages: config.agent.stream_partial_messages,
      systemPrompt: config.order.system_prompt ?? DEFAULT_ORDER_SYSTEM_PROMPT,
      mcpConfig: deps.mcpConfig,
      // An ordering run has no single owning ticket — identify it by the runId (used for the SDK run
      // title + as the key the orchestrator resolves the run's tool executors / live log by).
      issueRef: {
        id: ctx.runId,
        identifier: `order:${ctx.runId.slice(0, 8)}`,
        title: `sequencing ${anchorIssue.identifier} + others`,
      },
    };
    const model = config.order.model ?? config.agent.model;
    if (model !== undefined) runOpts.model = model;
    runOpts.effort = config.order.effort;
    runOpts.thinking = config.order.thinking;
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
    // Natural end without a submitted order: the agent stopped without delivering one.
    return { kind: 'failed', error: 'ordering ended without a submitted order' };
  } finally {
    // Read-only run: never integrate/merge. Clean up the throwaway worktree (single_dir is a no-op).
    await workspaceManager.cleanup(anchorIssue).catch(() => undefined);
  }
}
