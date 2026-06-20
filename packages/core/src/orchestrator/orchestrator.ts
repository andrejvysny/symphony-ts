import { randomUUID } from 'node:crypto';
import {
  AGENT_DEFS,
  buildOrderSdkMcpServer,
  buildPlanSdkMcpServer,
  detectAgent,
  validateOrderSubmission,
  type AgentEvent,
  type AskQuestionInput,
  type CodingAgentBackend,
  type McpConfig,
  type OrderSubmission,
  type OrderToolDeps,
  type PlanToolDeps,
} from '@symphony/agent-backends';
import type {
  Blocker,
  ErrorCategory,
  IssuePlan,
  IssueUsage,
  NormalizedIssue,
  OrderProposal,
  OrderRun,
  PlanAsk,
  PlanComment,
  PlanQuestion,
  PlanTextAnchor,
} from '@symphony/shared';
import {
  type Tracker,
  supportsBoard,
  supportsIssueWriter,
  supportsOrderStore,
  supportsPlanStore,
} from '@symphony/tracker';
import type { SymphonyConfig } from '../config/resolve.js';
import { dispatchPreflight } from '../config/validate.js';
import { type Logger, noopLogger } from '../observability/logger.js';
import { PromptBuilder } from '../prompt/builder.js';
import {
  formatPlanAnswers,
  planAnswersPrompt,
  planInitialPrompt,
  planRevisionPrompt,
} from '../prompt/plan-prompt.js';
import type { IWorkspaceManager } from '../workspace/manager.js';
import {
  blockedByNonTerminal,
  hasRequiredFields,
  retryDelay,
  sortForDispatch,
} from './dispatch.js';
import { runOrderWorker, type OrderOutcome, type OrderRunControl } from './order-worker.js';
import { orderAnswersPrompt, orderInitialPrompt } from '../prompt/order-prompt.js';
import { runPlanWorker, type PlanOutcome, type PlanRunControl } from './plan-worker.js';
import {
  createState,
  EVENT_BUFFER_CAP,
  newRunningEntry,
  type OrchestratorState,
  type OrderRunEntry,
  type PlanRunEntry,
  type RunningEntry,
} from './state.js';
import { integrateUsage } from './token-accounting.js';
import { runWorker, type WorkerOutcome } from './worker.js';

export interface OrchestratorDeps {
  tracker: Tracker;
  backend: CodingAgentBackend;
  workspaceManager: IWorkspaceManager;
  config: SymphonyConfig;
  promptBuilder?: PromptBuilder;
  logger?: Logger;
  /** MCP servers (e.g. tracker_api) passed to every agent run. */
  mcpConfig?: McpConfig;
  /** Hot-reload hook: returns the latest config + prompt body, or null to keep current. */
  reload?: () => { config: SymphonyConfig; promptBody: string } | null;
  /** Rebuild deps for a new project on {@link Orchestrator.switchProject} (live re-point). */
  trackerFactory?: (config: SymphonyConfig) => Tracker;
  mcpConfigFactory?: (config: SymphonyConfig) => McpConfig | undefined;
  workspaceManagerFactory?: (config: SymphonyConfig) => IWorkspaceManager;
  /** Injectable clock (tests). */
  now?: () => number;
}

type StopIntent = 'terminal' | 'nonactive' | 'stall' | 'manual';

export class Orchestrator {
  private readonly state: OrchestratorState = createState();
  // Mutable: swapped atomically by switchProject (live project re-point).
  private tracker: Tracker;
  private readonly backend: CodingAgentBackend;
  private workspaceManager: IWorkspaceManager;
  private readonly logger: Logger;
  private readonly reload:
    | (() => { config: SymphonyConfig; promptBody: string } | null)
    | undefined;
  private readonly trackerFactory: ((config: SymphonyConfig) => Tracker) | undefined;
  private readonly mcpConfigFactory:
    | ((config: SymphonyConfig) => McpConfig | undefined)
    | undefined;
  private readonly workspaceManagerFactory:
    | ((config: SymphonyConfig) => IWorkspaceManager)
    | undefined;
  private readonly now: () => number;
  private promptBuilder: PromptBuilder;
  private config: SymphonyConfig;
  private mcpConfig: McpConfig | undefined;
  private readonly stopIntents = new Map<string, StopIntent>();
  /** Operator-terminated issues held back from re-dispatch until moved/resumed. */
  private readonly paused = new Set<string>();
  /** Per-issue live-log subscribers (SSE). */
  private readonly logSubscribers = new Map<string, Set<(ev: AgentEvent) => void>>();
  /** Global board/state-change subscribers (SSE) — notified after every settled mutation. */
  private readonly boardSubscribers = new Set<() => void>();
  /** Issues whose auto-merge on accept hit a conflict; surfaced to the operator until resolved. */
  private readonly mergeFailures = new Map<
    string,
    { issue: NormalizedIssue; identifier: string; reason: string; at: number }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private stopping = false;
  /** One-time agent-binary detection result (populated at start). */
  private detection: { found: boolean; binary: string } | undefined;

  constructor(deps: OrchestratorDeps) {
    this.tracker = deps.tracker;
    this.backend = deps.backend;
    this.workspaceManager = deps.workspaceManager;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
    this.reload = deps.reload;
    this.trackerFactory = deps.trackerFactory;
    this.mcpConfigFactory = deps.mcpConfigFactory;
    this.workspaceManagerFactory = deps.workspaceManagerFactory;
    this.now = deps.now ?? (() => Date.now());
    this.promptBuilder = deps.promptBuilder ?? new PromptBuilder('');
    this.mcpConfig = deps.mcpConfig;
  }

  /** The live tracker (swapped by switchProject) — the dashboard reads through this. */
  currentTracker(): Tracker {
    return this.tracker;
  }

  /** The live resolved config (reflects switchProject / applyConfig). */
  currentConfig(): SymphonyConfig {
    return this.config;
  }

  /**
   * Apply a new resolved config immediately WITHOUT rebuilding the tracker (settings changes).
   * Tracker/repo scope changes must go through {@link switchProject}.
   */
  applyConfig(next: SymphonyConfig): void {
    this.config = next;
  }

  /**
   * Apply a settings change, rebuilding the workspace manager when the workspace mode/repo/root
   * changed (single_dir ⇄ worktree needs a different manager class + a fresh init). Rebuilds only
   * when idle: if agents are running the whole workspace change is deferred (config keeps the current
   * workspace block) so the running manager never mismatches its mode — the persisted change applies
   * on the next idle settings apply or a restart. Non-workspace settings always apply immediately.
   */
  async applySettings(next: SymphonyConfig): Promise<void> {
    return this.enqueue(async () => {
      const prev = this.config;
      const wsChanged =
        prev.workspace.mode !== next.workspace.mode ||
        prev.workspace.repo !== next.workspace.repo ||
        prev.workspace.root !== next.workspace.root;
      if (wsChanged && this.state.running.size > 0) {
        this.config = { ...next, workspace: prev.workspace };
        this.logger.info({}, 'workspace settings change deferred until agents are idle');
        return;
      }
      this.config = next;
      if (wsChanged && this.workspaceManagerFactory) {
        const mgr = this.workspaceManagerFactory(next);
        await mgr.init();
        this.workspaceManager = mgr;
        this.logger.info(
          { mode: next.workspace.mode },
          'workspace manager rebuilt for settings change',
        );
      }
    });
  }

  // ---- public lifecycle ----

  start(): void {
    this.running = true;
    void this.enqueue(() => this.startupCleanup())
      .then(() => this.enqueue(() => this.migrateDroppedStates()))
      .then(() => this.detectAgentBinary())
      .finally(() => this.scheduleTick(0));
  }

  /** Detect the configured agent binary once at startup (PATH + capability probe). */
  private async detectAgentBinary(): Promise<void> {
    const { backend, command } = this.config.agent;
    const binary =
      backend === 'codex-cli'
        ? (command ?? 'codex')
        : backend === 'opencode-cli'
          ? (command ?? 'opencode')
          : (command ?? 'claude'); // claude-sdk + claude-cli both drive `claude`
    // Reuse the matching CLI def's probe spec (claude-sdk shares the claude-cli def's probes).
    const def = AGENT_DEFS[backend === 'claude-sdk' ? 'claude-cli' : backend];
    try {
      const result = await detectAgent({
        binary,
        ...(def?.versionArgs ? { versionArgs: def.versionArgs } : {}),
        ...(def?.helpArgs ? { helpArgs: def.helpArgs } : {}),
        ...(def?.capabilityFlags ? { capabilityFlags: def.capabilityFlags } : {}),
      });
      this.detection = { found: result.found, binary };
      if (!result.found) {
        this.logger.warn(
          { binary },
          'configured agent binary not found on PATH; dispatch will be skipped until resolved',
        );
      } else {
        this.logger.info(
          { binary, ...(result.version ? { version: result.version } : {}) },
          'agent binary detected',
        );
      }
    } catch (e) {
      // Detection must never crash startup; leave it undefined (preflight stays optimistic).
      this.logger.warn({ binary, error: String(e) }, 'agent detection failed; continuing');
    }
  }

  /** Remove workspaces for issues already in a terminal state (SPEC §8.6). */
  private async startupCleanup(): Promise<void> {
    try {
      const terminal = await this.tracker.fetchIssuesByStates(this.config.tracker.terminal_states);
      for (const issue of terminal) {
        await this.workspaceManager.cleanup(issue).catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn({ error: String(e) }, 'startup terminal cleanup failed; continuing');
    }
  }

  /**
   * One-time migration for the simplified workflow: issues left in a now-removed active lane
   * ("Rework"/"Merging") are restated to the in-progress state so they aren't stranded in a hidden
   * board lane (rework is now In Progress + a `rework` label). Best-effort; runs at startup + switch.
   */
  private async migrateDroppedStates(): Promise<void> {
    const t = this.config.tracker;
    const target = t.in_progress_state;
    if (target === '' || !t.active_states.includes(target)) return;
    const tracker = this.tracker;
    if (!supportsBoard(tracker)) return;
    if (!supportsIssueWriter(tracker)) return;
    const known = new Set(
      [t.backlog_state, ...t.active_states, t.review_state, ...t.terminal_states].filter(Boolean),
    );
    try {
      for (const i of await tracker.fetchAllIssues()) {
        if (/^(rework|merging)$/i.test(i.state) && !known.has(i.state)) {
          await tracker.updateIssueState(i.id, target).catch(() => undefined);
          this.logger.info(
            { issue_id: i.id, issue_identifier: i.identifier, from: i.state, to: target },
            'migrated dropped-state issue to in-progress',
          );
        }
      }
    } catch (e) {
      this.logger.warn({ error: String(e) }, 'dropped-state migration failed; continuing');
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.state.tickTimer) clearTimeout(this.state.tickTimer);
    this.state.tickTimer = null;
    for (const r of this.state.retryAttempts.values()) clearTimeout(r.timer);
    this.state.retryAttempts.clear();
    for (const entry of this.state.running.values()) entry.abort.abort();
    for (const entry of this.state.planRuns.values()) entry.run.abort.abort();
    for (const entry of this.state.orderRuns.values()) entry.run.abort.abort();
    this.rejectAllPendingAsks('orchestrator stopping');
    await this.queue.catch(() => undefined);
  }

  /** Trigger an immediate poll cycle (coalesced). Returns when it completes. */
  async requestRefresh(): Promise<{ coalesced: boolean }> {
    if (this.state.pollCheckInProgress) return { coalesced: true };
    await this.enqueue(() => this.cycle());
    return { coalesced: false };
  }

  /** Run a single poll-and-dispatch cycle to completion (used by tests). */
  async runOnce(): Promise<void> {
    await this.enqueue(() => this.cycle());
  }

  /** Wait for the internal mutation queue to drain (test helper). */
  async settle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  // ---- operator control (dashboard) ----

  /** Stop a running session and hold the issue back from re-dispatch. */
  async terminate(issueId: string): Promise<{ terminated: boolean }> {
    return this.enqueue(async () => {
      this.paused.add(issueId);
      const retry = this.state.retryAttempts.get(issueId);
      if (retry) {
        clearTimeout(retry.timer);
        this.state.retryAttempts.delete(issueId);
        this.state.claimed.delete(issueId);
      }
      const entry = this.state.running.get(issueId);
      if (!entry) return { terminated: false };
      this.stopIntents.set(issueId, 'manual');
      // Abort propagates to the backend, which owns tmux kill-session (agent-neutral).
      entry.abort.abort();
      this.logger.info(
        { issue_id: issueId, issue_identifier: entry.identifier },
        'operator terminate requested',
      );
      return { terminated: true };
    });
  }

  /** Terminate every running session. */
  async terminateAll(): Promise<{ terminated: number }> {
    const ids = [...this.state.running.keys()];
    let n = 0;
    for (const id of ids) {
      const r = await this.terminate(id);
      if (r.terminated) n += 1;
    }
    return { terminated: n };
  }

  /** Allow a previously-terminated issue to be dispatched again. */
  resume(issueId: string): void {
    this.paused.delete(issueId);
  }

  /**
   * Clear a blocked issue (operator recovery) so the next poll can re-dispatch it. An issue
   * blocked on operator input (AskUserQuestion) or by the continuation cap otherwise stays
   * blocked+claimed until its tracker state leaves active (reconcileBlocked). This is the
   * manual escape hatch that does not require bouncing the ticket through another state.
   */
  async unblock(issueId: string): Promise<{ unblocked: boolean }> {
    return this.enqueue(async () => {
      const entry = this.state.blocked.get(issueId);
      if (!entry) return { unblocked: false };
      this.state.blocked.delete(issueId);
      this.state.claimed.delete(issueId);
      this.state.continuations.delete(issueId);
      this.logger.info(
        { issue_id: issueId, issue_identifier: entry.identifier },
        'operator unblock requested; eligible for re-dispatch',
      );
      return { unblocked: true };
    });
  }

  // ---- plan mode (read-only "Plan" track on Backlog tickets) ----

  /** A plan run's current artifact for the dashboard (null when none / tracker has no plan store). */
  async getPlan(issueId: string): Promise<IssuePlan | null> {
    const tracker = this.tracker;
    return supportsPlanStore(tracker) ? tracker.getPlan(issueId) : null;
  }

  /** Test seam: the live plan run's tool executors (so tests can drive symphony_ask/submit_plan). */
  planRunDepsForTest(issueId: string): PlanToolDeps | undefined {
    return this.state.planRuns.get(issueId)?.deps;
  }

  /**
   * Launch a read-only planning run on a Backlog ticket. `customInstructions` is the operator's
   * optional free-text steer from the dashboard, folded into the agent's first-turn prompt.
   */
  async startPlan(
    issueId: string,
    customInstructions?: string,
  ): Promise<{ started: boolean; reason?: string }> {
    return this.enqueue(async () => {
      const gate = this.planPreconditions();
      if (gate) return { started: false, reason: gate };
      if (this.state.planRuns.has(issueId))
        return { started: false, reason: 'a plan run is already active' };
      for (const e of this.state.orderRuns.values())
        if (e.issueIds.includes(issueId))
          return { started: false, reason: 'this ticket is in an active ordering run' };
      if (this.availableSlots() <= 0) return { started: false, reason: 'no available agent slot' };
      const issue = await this.findIssueById(issueId);
      if (!issue) return { started: false, reason: 'issue not found' };
      const backlog = this.config.tracker.backlog_state;
      if (backlog && issue.state !== backlog)
        return { started: false, reason: `plan is only available for ${backlog} tickets` };
      await this.persistPlan(issueId, (p) => ({
        ...this.clearedPlan(p),
        status: 'planning',
        pendingAsk: null,
      }));
      this.resume(issueId);
      this.dispatchPlan(issue, { prompt: planInitialPrompt(issue, customInstructions) });
      return { started: true };
    });
  }

  /** Answer the plan run's pending question (live → resume in-session; pause → re-dispatch). */
  async answerPlanQuestion(
    issueId: string,
    askId: string,
    answers: Record<string, string | string[]>,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.enqueue(async () => {
      const tracker = this.tracker;
      if (!supportsPlanStore(tracker))
        return { ok: false, reason: 'tracker does not support plans' };
      let matched: PlanQuestion[] | undefined;
      const updated = await this.persistPlan(issueId, (p) => {
        const base = this.basePlan(p);
        if (!base.pendingAsk || base.pendingAsk.id !== askId) return base; // stale / no pending → no-op
        matched = base.pendingAsk.questions;
        const answered: PlanAsk = {
          ...base.pendingAsk,
          answers,
          answeredAt: new Date(this.now()).toISOString(),
        };
        return { ...base, status: 'planning', pendingAsk: null, qa: [...base.qa, answered] };
      });
      if (!matched) return { ok: false, reason: 'no matching pending question' };
      // Live mode: the agent's symphony_ask is blocked on a promise — resolve it to continue in-session.
      const pending = this.state.pendingAsks.get(askId);
      if (pending) {
        this.state.pendingAsks.delete(askId);
        pending.resolve(formatPlanAnswers(matched, answers));
        this.emitBoardChanged();
        return { ok: true };
      }
      // Pause mode: the run ended when it asked — re-dispatch, resuming the session with the answers.
      if (this.state.planRuns.has(issueId)) return { ok: false, reason: 'plan run still active' };
      if (this.availableSlots() <= 0)
        return { ok: false, reason: 'no available agent slot to resume' };
      const issue = await this.findIssueById(issueId);
      if (!issue) return { ok: false, reason: 'issue not found' };
      const sessionId = updated?.sessionId;
      this.dispatchPlan(issue, {
        prompt: planAnswersPrompt(issue, matched, answers),
        ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
      });
      this.emitBoardChanged();
      return { ok: true };
    });
  }

  /** Re-run the plan agent to revise the plan, addressing the operator's open comments. */
  async revisePlan(issueId: string): Promise<{ ok: boolean; reason?: string }> {
    return this.enqueue(async () => {
      const tracker = this.tracker;
      if (!supportsPlanStore(tracker))
        return { ok: false, reason: 'tracker does not support plans' };
      if (this.state.planRuns.has(issueId))
        return { ok: false, reason: 'a plan run is already active' };
      if (this.availableSlots() <= 0) return { ok: false, reason: 'no available agent slot' };
      const plan = await tracker.getPlan(issueId);
      if (!plan?.markdown) return { ok: false, reason: 'no plan to revise' };
      const issue = await this.findIssueById(issueId);
      if (!issue) return { ok: false, reason: 'issue not found' };
      const unresolved = plan.comments.filter((c) => !c.resolved);
      await this.persistPlan(issueId, (p) => ({ ...this.clearedPlan(p), status: 'planning' }));
      this.dispatchPlan(issue, {
        prompt: planRevisionPrompt(issue, unresolved),
        ...(plan.sessionId !== undefined ? { resumeSessionId: plan.sessionId } : {}),
      });
      return { ok: true };
    });
  }

  /** Persist an operator's direct edit to the plan markdown. */
  async editPlan(issueId: string, markdown: string): Promise<{ ok: boolean; reason?: string }> {
    return this.enqueue(async () => {
      if (!supportsPlanStore(this.tracker))
        return { ok: false, reason: 'tracker does not support plans' };
      if (this.state.planRuns.has(issueId))
        return { ok: false, reason: 'cannot edit while a plan run is active' };
      await this.persistPlan(issueId, (p) => {
        const base = this.basePlan(p);
        return {
          ...base,
          markdown,
          editedByUser: true,
          status: base.status === 'approved' ? 'approved' : 'ready',
        };
      });
      this.emitBoardChanged();
      return { ok: true };
    });
  }

  /** Add an operator comment anchored to a span of the plan markdown. */
  async addPlanComment(
    issueId: string,
    anchor: PlanTextAnchor,
    body: string,
  ): Promise<{ id: string }> {
    return this.enqueue(async () => {
      const id = randomUUID();
      await this.persistPlan(issueId, (p) => {
        const base = this.basePlan(p);
        const comment: PlanComment = {
          id,
          at: new Date(this.now()).toISOString(),
          anchor,
          body,
          resolved: false,
          author: 'operator',
        };
        return { ...base, comments: [...base.comments, comment] };
      });
      this.emitBoardChanged();
      return { id };
    });
  }

  /** Resolve / reopen a plan comment. */
  async resolvePlanComment(
    issueId: string,
    commentId: string,
    resolved: boolean,
  ): Promise<{ ok: boolean }> {
    return this.enqueue(async () => {
      await this.persistPlan(issueId, (p) => {
        const base = this.basePlan(p);
        return {
          ...base,
          comments: base.comments.map((c) => (c.id === commentId ? { ...c, resolved } : c)),
        };
      });
      this.emitBoardChanged();
      return { ok: true };
    });
  }

  /** Approve a ready plan: move the ticket Backlog → entry lane so normal dispatch picks it up. */
  async approvePlan(issueId: string): Promise<{ approved: boolean; reason?: string }> {
    return this.enqueue(async () => {
      const tracker = this.tracker;
      if (!supportsPlanStore(tracker))
        return { approved: false, reason: 'tracker does not support plans' };
      if (this.state.planRuns.has(issueId))
        return { approved: false, reason: 'a plan run is still active' };
      const plan = await tracker.getPlan(issueId);
      if (!plan) return { approved: false, reason: 'no plan' };
      if (plan.pendingAsk) return { approved: false, reason: 'answer the pending question first' };
      if (!plan.markdown) return { approved: false, reason: 'no plan to approve' };
      await this.persistPlan(issueId, (p) => ({
        ...this.basePlan(p),
        status: 'approved',
        pendingAsk: null,
      }));
      const target = this.config.tracker.active_states[0];
      if (target && supportsIssueWriter(this.tracker)) {
        try {
          await this.tracker.updateIssueState(issueId, target);
        } catch (e) {
          this.logger.warn(
            { issue_id: issueId, error: String(e) },
            'approve: move to entry lane failed',
          );
        }
      }
      this.resume(issueId);
      this.scheduleTick(0);
      return { approved: true };
    });
  }

  /** Abort a live plan run (or clear a parked/awaiting plan when no run is active). */
  async cancelPlan(issueId: string): Promise<{ cancelled: boolean }> {
    return this.enqueue(async () => {
      this.rejectPendingAsksFor(issueId, 'plan cancelled');
      const entry = this.state.planRuns.get(issueId);
      if (entry) {
        entry.run.abort.abort(); // onPlanWorkerExit finalizes status
        return { cancelled: true };
      }
      await this.persistPlan(issueId, (p) =>
        p
          ? { ...this.clearedPlan(p), status: p.markdown ? 'ready' : 'failed', pendingAsk: null }
          : this.basePlan(p),
      );
      this.emitBoardChanged();
      return { cancelled: false };
    });
  }

  // ---- plan run internals ----

  private planPreconditions(): string | null {
    if (this.config.agent.backend !== 'claude-sdk')
      return 'plan mode requires the claude-sdk backend';
    if (!supportsPlanStore(this.tracker)) return 'the active tracker does not support plans';
    return null;
  }

  /** A fresh base plan when none exists yet; returns the existing plan unchanged otherwise. */
  private basePlan(p: IssuePlan | undefined): IssuePlan {
    if (p) return p;
    const ts = new Date(this.now()).toISOString();
    return { status: 'planning', qa: [], comments: [], revision: 0, createdAt: ts, updatedAt: ts };
  }

  /** Like {@link basePlan}, but drops a prior failure's error fields — used when (re)starting a run. */
  private clearedPlan(p: IssuePlan | undefined): IssuePlan {
    const base = { ...this.basePlan(p) };
    delete base.error;
    delete base.errorCategory;
    return base;
  }

  /** Read-modify-write the issue's plan (best-effort; no-op if the tracker has no plan store). */
  private async persistPlan(
    issueId: string,
    fn: (p: IssuePlan | undefined) => IssuePlan,
  ): Promise<IssuePlan | undefined> {
    const tracker = this.tracker;
    if (!supportsPlanStore(tracker)) return undefined;
    try {
      return await tracker.updatePlan(issueId, fn);
    } catch (e) {
      this.logger.warn({ issue_id: issueId, error: String(e) }, 'failed to persist plan');
      return undefined;
    }
  }

  private async findIssueById(issueId: string): Promise<NormalizedIssue | undefined> {
    const tracker = this.tracker;
    if (!supportsBoard(tracker)) return undefined;
    return (await tracker.fetchAllIssues().catch(() => [])).find((i) => i.id === issueId);
  }

  private rejectPendingAsksFor(issueId: string, reason: string): void {
    for (const [askId, p] of this.state.pendingAsks) {
      if (p.issueId !== issueId) continue;
      this.state.pendingAsks.delete(askId);
      try {
        p.reject(new Error(reason));
      } catch {
        /* an already-settled promise must not break teardown */
      }
    }
  }

  private rejectPendingAsksForRun(runId: string, reason: string): void {
    for (const [askId, p] of this.state.pendingAsks) {
      if (p.runId !== runId) continue;
      this.state.pendingAsks.delete(askId);
      try {
        p.reject(new Error(reason));
      } catch {
        /* an already-settled promise must not break teardown */
      }
    }
  }

  private rejectAllPendingAsks(reason: string): void {
    for (const [, p] of this.state.pendingAsks) {
      try {
        p.reject(new Error(reason));
      } catch {
        /* ignore */
      }
    }
    this.state.pendingAsks.clear();
  }

  /** Launch a plan run: build the per-run plan MCP server (closures over this run) and stream it. */
  private dispatchPlan(
    issue: NormalizedIssue,
    opts: { prompt: string; resumeSessionId?: string },
  ): void {
    const run = newRunningEntry(issue, 0, this.now());
    const control: PlanRunControl = { submitted: false, parkedAskId: null };
    const entry: PlanRunEntry = { run, control, mode: this.config.plan.qa_mode };
    this.state.planRuns.set(issue.id, entry);

    const deps: PlanToolDeps = {
      ask: (questions) => this.onPlanAsk(issue.id, entry, questions),
      submitPlan: (markdown) => this.onPlanSubmit(issue.id, entry, markdown),
    };
    entry.deps = deps;
    const planMcp: McpConfig = { sdkServers: () => buildPlanSdkMcpServer(deps) };

    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    log.info({ ...(opts.resumeSessionId ? { resuming: true } : {}) }, 'dispatching plan run');

    const ctx = {
      issue,
      prompt: opts.prompt,
      signal: run.abort.signal,
      emit: (ev: AgentEvent) => this.onAgentEvent(run, ev),
      onSession: (sid: string) => {
        run.sessionId = sid;
      },
      onWorktree: (p: string) => {
        run.workspacePath = p;
      },
      control,
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
    };

    void runPlanWorker(
      {
        workspaceManager: this.workspaceManager,
        backend: this.backend,
        config: this.config,
        mcpConfig: planMcp,
      },
      ctx,
    ).then(
      (outcome) => this.enqueue(() => this.onPlanWorkerExit(issue.id, outcome)),
      (err) =>
        this.enqueue(() => this.onPlanWorkerExit(issue.id, { kind: 'failed', error: String(err) })),
    );
  }

  /** Normalize the agent's `symphony_ask` input into persisted {@link PlanQuestion}s (id-assigned). */
  private toPlanQuestions(questions: AskQuestionInput[]): PlanQuestion[] {
    return questions.map((q) => ({
      id: randomUUID(),
      header: q.header,
      question: q.question,
      multiSelect: q.multiSelect ?? false,
      ...(q.options !== undefined
        ? {
            options: q.options.map((o) => ({
              label: o.label,
              ...(o.description !== undefined ? { description: o.description } : {}),
              ...(o.recommended !== undefined ? { recommended: o.recommended } : {}),
            })),
          }
        : {}),
    }));
  }

  /** Executor for the agent's `symphony_ask` tool: persist the question, then block (live) or park (pause). */
  private async onPlanAsk(
    issueId: string,
    entry: PlanRunEntry,
    questions: AskQuestionInput[],
  ): Promise<string> {
    const askId = randomUUID();
    const planQuestions = this.toPlanQuestions(questions);
    const ask: PlanAsk = {
      id: askId,
      at: new Date(this.now()).toISOString(),
      questions: planQuestions,
    };
    await this.persistPlan(issueId, (p) => ({
      ...this.basePlan(p),
      status: 'awaiting_input',
      pendingAsk: ask,
    }));
    this.emitBoardChanged();
    if (entry.mode === 'live') {
      return new Promise<string>((resolve, reject) => {
        this.state.pendingAsks.set(askId, { issueId, resolve, reject });
      });
    }
    // Pause mode: record, return the tool result, then end the run on the next tick so the transcript
    // stays well-formed (tool_use + tool_result) and the session resumes cleanly on answer.
    entry.control.parkedAskId = askId;
    setTimeout(() => entry.run.abort.abort(), 0);
    return 'Questions recorded. Stop here — the operator will answer, then you will be re-prompted with their answers.';
  }

  /** Executor for the agent's `symphony_submit_plan` tool: persist the plan, then end the run. */
  private async onPlanSubmit(
    issueId: string,
    entry: PlanRunEntry,
    markdown: string,
  ): Promise<string> {
    await this.persistPlan(issueId, (p) => {
      const base = this.basePlan(p);
      return {
        ...base,
        status: 'ready',
        markdown,
        editedByUser: false,
        pendingAsk: null,
        revision: base.revision + 1,
        // A revision can rewrite the text a comment was anchored to; drop those orphaned comments
        // silently (the anchor's exact quote no longer appears in the new plan).
        comments: base.comments.filter((c) => markdown.includes(c.anchor.exact)),
      };
    });
    entry.control.submitted = true;
    this.emitBoardChanged();
    setTimeout(() => entry.run.abort.abort(), 0);
    return 'Plan recorded for operator review.';
  }

  private async onPlanWorkerExit(issueId: string, outcome: PlanOutcome): Promise<void> {
    const entry = this.state.planRuns.get(issueId);
    if (!entry) return;
    this.state.planRuns.delete(issueId);
    this.rejectPendingAsksFor(issueId, 'plan run ended');
    this.state.totals.secondsRunning += (this.now() - entry.run.startedAt) / 1000;
    const log = this.logger.child({ issue_id: issueId, issue_identifier: entry.run.identifier });
    // Fold plan-run tokens into the ticket's usage (best-effort), same path as execution runs.
    await this.persistUsage(entry.run, log);
    // Carry the session forward for revisions / pause-mode resume.
    if (entry.run.sessionId) {
      const sid = entry.run.sessionId;
      await this.persistPlan(issueId, (p) => ({ ...this.basePlan(p), sessionId: sid }));
    }
    switch (outcome.kind) {
      case 'ready':
        log.info({}, 'plan ready for review');
        break;
      case 'parked':
        log.info({}, 'plan parked for operator input (pause mode)');
        break;
      case 'aborted':
        await this.persistPlan(issueId, (p) => ({
          ...this.basePlan(p),
          status: p?.markdown ? 'ready' : 'failed',
          pendingAsk: null,
        }));
        log.info({}, 'plan run aborted/cancelled');
        break;
      case 'failed':
        await this.persistPlan(issueId, (p) => ({
          ...this.clearedPlan(p),
          status: 'failed',
          pendingAsk: null,
          error: outcome.error,
          ...(outcome.category !== undefined ? { errorCategory: outcome.category } : {}),
        }));
        log.warn(
          { error: outcome.error, ...(outcome.category ? { category: outcome.category } : {}) },
          'plan run failed',
        );
        break;
    }
    this.emitBoardChanged();
  }

  // ---- sequence mode (the "Order" track: LLM-ordered SUBSET of Backlog tickets) ----

  /** The order run artifact for the dashboard, or null when none / tracker has no order store. */
  async getOrder(runId: string): Promise<OrderRun | null> {
    return supportsOrderStore(this.tracker) ? this.tracker.getOrder(runId) : null;
  }

  /** All order runs for the active project (newest-first); empty when the tracker has no order store. */
  async listOrders(): Promise<OrderRun[]> {
    return supportsOrderStore(this.tracker) ? this.tracker.listOrders() : [];
  }

  /** Test seam: the live ordering run's tool executors (so tests can drive ask/submit_order). */
  orderRunDepsForTest(runId: string): OrderToolDeps | undefined {
    return this.state.orderRuns.get(runId)?.deps;
  }

  private orderPreconditions(): string | null {
    if (!this.config.order.enabled) return 'the sequence feature is disabled';
    if (this.config.agent.backend !== 'claude-sdk')
      return 'sequencing requires the claude-sdk backend';
    if (!supportsOrderStore(this.tracker)) return 'the active tracker does not support sequencing';
    return null;
  }

  /** A fresh base order run when none exists yet; returns the existing run unchanged otherwise. */
  private requireOrder(runId: string, p: OrderRun | undefined): OrderRun {
    if (p) return p;
    const ts = new Date(this.now()).toISOString();
    return {
      runId,
      status: 'ordering',
      selected: [],
      qa: [],
      revision: 0,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  /** Read-modify-write the order run (best-effort; auto-stamps updatedAt). */
  private async persistOrder(
    runId: string,
    fn: (p: OrderRun | undefined) => OrderRun,
  ): Promise<OrderRun | undefined> {
    const tracker = this.tracker;
    if (!supportsOrderStore(tracker)) return undefined;
    try {
      return await tracker.updateOrder(runId, (prev) => ({
        ...fn(prev),
        updatedAt: new Date(this.now()).toISOString(),
      }));
    } catch (e) {
      this.logger.warn({ run_id: runId, error: String(e) }, 'failed to persist order run');
      return undefined;
    }
  }

  /** Re-fetch the run's selected issues by their snapshotted ids (dropping any that no longer exist). */
  private async resolveOrderIssues(run: OrderRun): Promise<NormalizedIssue[]> {
    if (!supportsBoard(this.tracker)) return [];
    const all = await this.tracker.fetchAllIssues().catch(() => []);
    const byId = new Map(all.map((i) => [i.id, i]));
    const out: NormalizedIssue[] = [];
    for (const ref of run.selected) {
      const i = byId.get(ref.id);
      if (i) out.push(i);
    }
    return out;
  }

  /**
   * Launch a read-only ordering run over a SUBSET of Backlog tickets. Validates the subset (all exist,
   * all in Backlog, 2..max), reserves a slot, persists an `ordering` artifact, and dispatches.
   */
  async startOrder(
    ticketIds: string[],
    customInstructions?: string,
  ): Promise<{ started: boolean; runId?: string; reason?: string }> {
    return this.enqueue(async () => {
      const gate = this.orderPreconditions();
      if (gate) return { started: false, reason: gate };
      const ids = [...new Set(ticketIds)];
      if (ids.length < 2)
        return { started: false, reason: 'select at least 2 tickets to sequence' };
      if (ids.length > this.config.order.max_subset_size)
        return {
          started: false,
          reason: `select at most ${this.config.order.max_subset_size} tickets`,
        };
      if (this.availableSlots() <= 0) return { started: false, reason: 'no available agent slot' };
      if (!supportsBoard(this.tracker))
        return { started: false, reason: 'tracker does not support board reads' };
      const all = await this.tracker.fetchAllIssues().catch(() => []);
      const byId = new Map(all.map((i) => [i.id, i]));
      const backlog = this.config.tracker.backlog_state;
      const issues: NormalizedIssue[] = [];
      for (const id of ids) {
        const issue = byId.get(id);
        if (!issue) return { started: false, reason: `ticket ${id} not found` };
        if (backlog && issue.state !== backlog)
          return { started: false, reason: `${issue.identifier} is not in ${backlog}` };
        if (this.state.running.has(id) || this.state.planRuns.has(id))
          return { started: false, reason: `${issue.identifier} is busy in another run` };
        issues.push(issue);
      }
      for (const e of this.state.orderRuns.values())
        if (e.issueIds.some((id) => ids.includes(id)))
          return { started: false, reason: 'a selected ticket is already in another ordering run' };

      const runId = randomUUID();
      const sorted = sortForDispatch(issues);
      const instructions = customInstructions?.trim();
      const ts = new Date(this.now()).toISOString();
      await this.persistOrder(runId, () => ({
        runId,
        status: 'ordering',
        selected: sorted.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title })),
        ...(instructions ? { customInstructions: instructions } : {}),
        qa: [],
        revision: 0,
        createdAt: ts,
        updatedAt: ts,
      }));
      this.dispatchOrder(runId, sorted, {
        prompt: orderInitialPrompt(sorted, instructions),
        ...(instructions !== undefined ? { customInstructions: instructions } : {}),
      });
      this.emitBoardChanged();
      return { started: true, runId };
    });
  }

  /** Answer the ordering run's pending question (live → resume in-session; pause → re-dispatch). */
  async answerOrderQuestion(
    runId: string,
    askId: string,
    answers: Record<string, string | string[]>,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.enqueue(async () => {
      if (!supportsOrderStore(this.tracker))
        return { ok: false, reason: 'tracker does not support sequencing' };
      let matched: PlanQuestion[] | undefined;
      const updated = await this.persistOrder(runId, (p) => {
        const base = this.requireOrder(runId, p);
        if (!base.pendingAsk || base.pendingAsk.id !== askId) return base; // stale / no pending → no-op
        matched = base.pendingAsk.questions;
        const answered: PlanAsk = {
          ...base.pendingAsk,
          answers,
          answeredAt: new Date(this.now()).toISOString(),
        };
        return { ...base, status: 'ordering', pendingAsk: null, qa: [...base.qa, answered] };
      });
      if (!matched) return { ok: false, reason: 'no matching pending question' };
      const pending = this.state.pendingAsks.get(askId);
      if (pending) {
        this.state.pendingAsks.delete(askId);
        pending.resolve(formatPlanAnswers(matched, answers));
        this.emitBoardChanged();
        return { ok: true };
      }
      // Pause mode: re-dispatch, resuming the session with the answers.
      if (this.state.orderRuns.has(runId))
        return { ok: false, reason: 'ordering run still active' };
      if (this.availableSlots() <= 0)
        return { ok: false, reason: 'no available agent slot to resume' };
      if (!updated) return { ok: false, reason: 'order run not found' };
      const issues = await this.resolveOrderIssues(updated);
      if (issues.length < 2) return { ok: false, reason: 'fewer than 2 selected tickets remain' };
      const sorted = sortForDispatch(issues);
      this.dispatchOrder(runId, sorted, {
        prompt: orderAnswersPrompt(matched, answers),
        ...(updated.sessionId !== undefined ? { resumeSessionId: updated.sessionId } : {}),
        ...(updated.customInstructions !== undefined
          ? { customInstructions: updated.customInstructions }
          : {}),
      });
      this.emitBoardChanged();
      return { ok: true };
    });
  }

  /** Re-run the ordering agent (fresh analysis, optionally with new instructions; resumes the session). */
  async reRunOrder(
    runId: string,
    customInstructions?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.enqueue(async () => {
      const gate = this.orderPreconditions();
      if (gate) return { ok: false, reason: gate };
      if (this.state.orderRuns.has(runId))
        return { ok: false, reason: 'an ordering run is already active' };
      if (this.availableSlots() <= 0) return { ok: false, reason: 'no available agent slot' };
      if (!supportsOrderStore(this.tracker))
        return { ok: false, reason: 'tracker does not support sequencing' };
      const run = await this.tracker.getOrder(runId);
      if (!run) return { ok: false, reason: 'order run not found' };
      if (run.status === 'approved')
        return { ok: false, reason: 'this order was already approved' };
      const issues = await this.resolveOrderIssues(run);
      if (issues.length < 2) return { ok: false, reason: 'fewer than 2 selected tickets remain' };
      const instructions = customInstructions?.trim() || run.customInstructions;
      await this.persistOrder(runId, (p) => {
        const base = this.requireOrder(runId, p);
        const next: OrderRun = { ...base, status: 'ordering', pendingAsk: null };
        delete next.error;
        delete next.errorCategory;
        return next;
      });
      const sorted = sortForDispatch(issues);
      this.dispatchOrder(runId, sorted, {
        prompt: orderInitialPrompt(sorted, instructions),
        ...(run.sessionId !== undefined ? { resumeSessionId: run.sessionId } : {}),
        ...(instructions !== undefined ? { customInstructions: instructions } : {}),
      });
      this.emitBoardChanged();
      return { ok: true };
    });
  }

  /**
   * Approve a ready order: commit `rank` + `blockedBy` onto each selected ticket so the resolved
   * sequence + dependencies become visible and drive dispatch. `release` (default true) also moves the
   * batch Backlog → entry lane so it runs immediately; `release:false` records the order but KEEPS the
   * tickets in Backlog (the badges show, but nothing dispatches until they're moved to the entry lane).
   * `finalOrder` is the operator's (possibly drag-reordered) order; absent → the agent's proposal.
   * Dependency edges are filtered to those consistent with the final linear order → acyclic by construction.
   */
  async approveOrder(
    runId: string,
    finalOrder?: string[],
    release = true,
  ): Promise<{
    approved: boolean;
    reason?: string;
    applied?: number;
    skipped?: string[];
    released?: boolean;
  }> {
    return this.enqueue(async () => {
      const tracker = this.tracker;
      if (!supportsOrderStore(tracker))
        return { approved: false, reason: 'tracker does not support sequencing' };
      if (this.state.orderRuns.has(runId))
        return { approved: false, reason: 'an ordering run is still active' };
      const run = await tracker.getOrder(runId);
      if (!run) return { approved: false, reason: 'order run not found' };
      if (run.pendingAsk) return { approved: false, reason: 'answer the pending question first' };
      if (!run.proposal) return { approved: false, reason: 'no proposed order to approve' };

      // Final order = operator override (sanitized to the selected set) or the agent proposal; any
      // selected id missing from the override is appended in proposal order (never silently dropped).
      const selectedIds = new Set(run.selected.map((s) => s.id));
      const source = finalOrder && finalOrder.length > 0 ? finalOrder : run.proposal.order;
      const order: string[] = [];
      const seen = new Set<string>();
      for (const id of source)
        if (selectedIds.has(id) && !seen.has(id)) {
          order.push(id);
          seen.add(id);
        }
      for (const id of run.proposal.order)
        if (selectedIds.has(id) && !seen.has(id)) {
          order.push(id);
          seen.add(id);
        }
      const edited =
        finalOrder !== undefined && JSON.stringify(order) !== JSON.stringify(run.proposal.order);

      const result = await this.commitOrder(run, order, release);
      await this.persistOrder(runId, (p) => {
        const base = this.requireOrder(runId, p);
        const prop = base.proposal ?? run.proposal!;
        return {
          ...base,
          status: 'approved',
          released: release,
          pendingAsk: null,
          proposal: { ...prop, order, editedByUser: edited || prop.editedByUser === true },
        };
      });
      if (release) this.scheduleTick(0);
      this.emitBoardChanged();
      return {
        approved: true,
        applied: result.applied,
        skipped: result.skipped,
        released: release,
      };
    });
  }

  /**
   * Commit the resolved order: for each ticket at index k write `rank = k` and `blockedBy` (the
   * proposal's edges into it, FILTERED to blockers that precede it in `order` → acyclic by
   * construction). When `move` is true, also move it Backlog → entry lane (queue it for dispatch);
   * otherwise it stays in Backlog with the order recorded. Re-reads live state to skip tickets that
   * drifted out of Backlog or were deleted (reported back). Best-effort per ticket.
   */
  private async commitOrder(
    run: OrderRun,
    order: string[],
    move: boolean,
  ): Promise<{ applied: number; skipped: string[] }> {
    const tracker = this.tracker;
    if (!supportsIssueWriter(tracker)) return { applied: 0, skipped: [] };
    const proposalEdges = new Map((run.proposal?.tickets ?? []).map((t) => [t.id, t.blockedBy]));
    const position = new Map(order.map((id, idx) => [id, idx]));
    const all = supportsBoard(tracker) ? await tracker.fetchAllIssues().catch(() => []) : [];
    const byId = new Map(all.map((i) => [i.id, i]));
    const backlog = this.config.tracker.backlog_state;
    const entryLane = this.config.tracker.active_states[0];
    const skipped: string[] = [];
    let applied = 0;
    for (let k = 0; k < order.length; k++) {
      const id = order[k] as string;
      const issue = byId.get(id);
      if (!issue) {
        skipped.push(id);
        continue;
      }
      if (backlog && issue.state !== backlog) {
        skipped.push(issue.identifier);
        continue;
      }
      const blockedBy: Blocker[] = (proposalEdges.get(id) ?? [])
        .filter((b) => {
          const bp = position.get(b);
          return b !== id && bp !== undefined && bp < k;
        })
        .map((b) => byId.get(b))
        .filter((bi): bi is NormalizedIssue => bi !== undefined)
        .map((bi) => ({ id: bi.id, identifier: bi.identifier, state: bi.state }));
      try {
        await tracker.updateIssue(id, { rank: k, blockedBy });
        if (move && entryLane) await tracker.updateIssueState(id, entryLane);
        applied += 1;
      } catch (e) {
        this.logger.warn(
          { issue_id: id, error: String(e) },
          'commitOrder: failed to commit/move ticket',
        );
        skipped.push(issue.identifier);
      }
    }
    return { applied, skipped };
  }

  /** Abort a live ordering run (or clear a parked/awaiting run when none is active). */
  async cancelOrder(runId: string): Promise<{ cancelled: boolean }> {
    return this.enqueue(async () => {
      this.rejectPendingAsksForRun(runId, 'ordering cancelled');
      const entry = this.state.orderRuns.get(runId);
      if (entry) {
        entry.run.abort.abort(); // onOrderWorkerExit finalizes status
        return { cancelled: true };
      }
      await this.persistOrder(runId, (p) =>
        p
          ? {
              ...this.requireOrder(runId, p),
              status: p.proposal ? 'ready' : 'failed',
              pendingAsk: null,
            }
          : this.requireOrder(runId, p),
      );
      this.emitBoardChanged();
      return { cancelled: false };
    });
  }

  // ---- order run internals ----

  /** Launch an ordering run: build the per-run order MCP server (closures over this run) and stream it. */
  private dispatchOrder(
    runId: string,
    issues: NormalizedIssue[],
    opts: { prompt: string; resumeSessionId?: string; customInstructions?: string },
  ): void {
    const anchor = issues[0] as NormalizedIssue;
    // Synthetic issue whose id === runId so live-log routing (onAgentEvent → logSubscribers by
    // issue.id) keys by the RUN, not a ticket; the real anchor is passed to the worker separately.
    const syntheticIssue: NormalizedIssue = {
      ...anchor,
      id: runId,
      identifier: `order:${runId.slice(0, 8)}`,
    };
    const run = newRunningEntry(syntheticIssue, 0, this.now());
    const control: OrderRunControl = { submitted: false, parkedAskId: null };
    const entry: OrderRunEntry = {
      runId,
      issueIds: issues.map((i) => i.id),
      run,
      control,
      mode: this.config.order.qa_mode,
      ...(opts.customInstructions !== undefined
        ? { customInstructions: opts.customInstructions }
        : {}),
    };
    this.state.orderRuns.set(runId, entry);

    const selectedIds = new Set(issues.map((i) => i.id));
    const deps: OrderToolDeps = {
      ask: (questions) => this.onOrderAsk(runId, entry, questions),
      submitOrder: (submission) => this.onOrderSubmit(runId, entry, selectedIds, submission),
    };
    entry.deps = deps;
    const orderMcp: McpConfig = { sdkServers: () => buildOrderSdkMcpServer(deps) };

    const log = this.logger.child({ run_id: runId });
    log.info(
      { tickets: issues.length, ...(opts.resumeSessionId ? { resuming: true } : {}) },
      'dispatching ordering run',
    );

    const ctx = {
      runId,
      anchorIssue: anchor,
      prompt: opts.prompt,
      signal: run.abort.signal,
      emit: (ev: AgentEvent) => this.onAgentEvent(run, ev),
      onSession: (sid: string) => {
        run.sessionId = sid;
      },
      onWorktree: (p: string) => {
        run.workspacePath = p;
      },
      control,
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
    };

    void runOrderWorker(
      {
        workspaceManager: this.workspaceManager,
        backend: this.backend,
        config: this.config,
        mcpConfig: orderMcp,
      },
      ctx,
    ).then(
      (outcome) => this.enqueue(() => this.onOrderWorkerExit(runId, outcome)),
      (err) =>
        this.enqueue(() => this.onOrderWorkerExit(runId, { kind: 'failed', error: String(err) })),
    );
  }

  /** Executor for the agent's `symphony_ask` tool on an ordering run: block (live) or park (pause). */
  private async onOrderAsk(
    runId: string,
    entry: OrderRunEntry,
    questions: AskQuestionInput[],
  ): Promise<string> {
    const askId = randomUUID();
    const ask: PlanAsk = {
      id: askId,
      at: new Date(this.now()).toISOString(),
      questions: this.toPlanQuestions(questions),
    };
    await this.persistOrder(runId, (p) => ({
      ...this.requireOrder(runId, p),
      status: 'awaiting_input',
      pendingAsk: ask,
    }));
    this.emitBoardChanged();
    if (entry.mode === 'live') {
      return new Promise<string>((resolve, reject) => {
        this.state.pendingAsks.set(askId, { runId, resolve, reject });
      });
    }
    entry.control.parkedAskId = askId;
    setTimeout(() => entry.run.abort.abort(), 0);
    return 'Questions recorded. Stop here — the operator will answer, then you will be re-prompted with their answers.';
  }

  /** Executor for `symphony_submit_order`: validate + persist the proposal, then end the run. */
  private async onOrderSubmit(
    runId: string,
    entry: OrderRunEntry,
    selectedIds: Set<string>,
    submission: OrderSubmission,
  ): Promise<{ ok: boolean; text: string }> {
    const err = validateOrderSubmission(submission, selectedIds);
    if (err)
      return { ok: false, text: `${err} Call symphony_submit_order again with a corrected order.` };
    const proposal: OrderProposal = {
      order: submission.order,
      tickets: submission.tickets.map((t) => ({
        id: t.id,
        blockedBy: t.blockedBy,
        rationale: t.rationale,
      })),
      summary: submission.summary,
    };
    await this.persistOrder(runId, (p) => {
      const base = this.requireOrder(runId, p);
      return { ...base, status: 'ready', proposal, pendingAsk: null, revision: base.revision + 1 };
    });
    entry.control.submitted = true;
    this.emitBoardChanged();
    setTimeout(() => entry.run.abort.abort(), 0);
    return { ok: true, text: 'Order recorded for operator review.' };
  }

  private async onOrderWorkerExit(runId: string, outcome: OrderOutcome): Promise<void> {
    const entry = this.state.orderRuns.get(runId);
    if (!entry) return;
    this.state.orderRuns.delete(runId);
    this.rejectPendingAsksForRun(runId, 'ordering run ended');
    this.state.totals.secondsRunning += (this.now() - entry.run.startedAt) / 1000;
    const log = this.logger.child({ run_id: runId });
    // Carry the session forward for re-runs / pause-mode resume. (Tokens are folded into global
    // totals by onAgentEvent; an ordering run has no single ticket to attribute per-issue usage to.)
    if (entry.run.sessionId) {
      const sid = entry.run.sessionId;
      await this.persistOrder(runId, (p) => ({ ...this.requireOrder(runId, p), sessionId: sid }));
    }
    switch (outcome.kind) {
      case 'ready':
        log.info({}, 'order ready for review');
        break;
      case 'parked':
        log.info({}, 'order parked for operator input (pause mode)');
        break;
      case 'aborted':
        await this.persistOrder(runId, (p) => ({
          ...this.requireOrder(runId, p),
          status: p?.proposal ? 'ready' : 'failed',
          pendingAsk: null,
        }));
        log.info({}, 'order run aborted/cancelled');
        break;
      case 'failed':
        await this.persistOrder(runId, (p) => {
          const base = this.requireOrder(runId, p);
          const next: OrderRun = {
            ...base,
            status: 'failed',
            pendingAsk: null,
            error: outcome.error,
          };
          delete next.errorCategory;
          if (outcome.category !== undefined) next.errorCategory = outcome.category;
          return next;
        });
        log.warn({ error: outcome.error }, 'order run failed');
        break;
    }
    this.emitBoardChanged();
  }

  /**
   * Live re-point to a different project: rebuild the tracker / MCP / workspace from `next`, abort
   * every running agent, reset all run state, and resume polling — no process restart. Atomic: the
   * new workspace is cloned/initialized BEFORE any teardown, so a bad repo aborts the switch with the
   * current project untouched. In-flight aborted workers find their entry gone on exit (no-op).
   */
  async switchProject(next: SymphonyConfig): Promise<{ switched: boolean }> {
    if (!this.trackerFactory || !this.workspaceManagerFactory) {
      throw new Error('switchProject requires tracker + workspace factories');
    }
    const trackerFactory = this.trackerFactory;
    const workspaceManagerFactory = this.workspaceManagerFactory;
    return this.enqueue(async () => {
      // 1. Build + init the new project first; throws (e.g. bad repo) before we touch live state.
      const newTracker = trackerFactory(next);
      const newWorkspace = workspaceManagerFactory(next);
      await newWorkspace.init();
      const newMcp = this.mcpConfigFactory ? this.mcpConfigFactory(next) : undefined;

      // 2. Tear down current run state (timers, running agents, all maps + token totals).
      if (this.state.tickTimer) clearTimeout(this.state.tickTimer);
      this.state.tickTimer = null;
      for (const r of this.state.retryAttempts.values()) clearTimeout(r.timer);
      this.state.retryAttempts.clear();
      for (const entry of this.state.running.values()) entry.abort.abort();
      for (const entry of this.state.planRuns.values()) entry.run.abort.abort();
      for (const entry of this.state.orderRuns.values()) entry.run.abort.abort();
      this.rejectAllPendingAsks('switching project');
      this.state.planRuns.clear();
      this.state.orderRuns.clear();
      this.state.running.clear();
      this.state.claimed.clear();
      this.state.completed.clear();
      this.state.continuations.clear();
      this.state.resumeSessions.clear();
      this.state.blocked.clear();
      this.stopIntents.clear();
      this.paused.clear();
      this.mergeFailures.clear();
      this.state.totals = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        secondsRunning: 0,
      };
      this.state.rateLimits = null;

      // 3. Swap in the new project and resume.
      this.tracker = newTracker;
      this.workspaceManager = newWorkspace;
      this.mcpConfig = newMcp;
      this.config = next;
      await this.startupCleanup();
      await this.migrateDroppedStates();
      this.logger.info(
        { project_id: next.tracker.project_id, repo: next.workspace.repo },
        'switched active project',
      );
      if (this.running) this.scheduleTick(0);
      return { switched: true };
    });
  }

  /** Subscribe to a running session's live events; replays the buffer first. Returns unsubscribe. */
  subscribeLogs(issueId: string, cb: (ev: AgentEvent) => void): () => void {
    const entry =
      this.state.running.get(issueId) ??
      this.state.planRuns.get(issueId)?.run ??
      this.state.orderRuns.get(issueId)?.run;
    if (entry) for (const ev of entry.eventBuffer) cb(ev);
    let set = this.logSubscribers.get(issueId);
    if (!set) {
      set = new Set();
      this.logSubscribers.set(issueId, set);
    }
    set.add(cb);
    return () => {
      const s = this.logSubscribers.get(issueId);
      if (s) {
        s.delete(cb);
        if (s.size === 0) this.logSubscribers.delete(issueId);
      }
    };
  }

  /** Subscribe to global board/state changes (SSE). Returns unsubscribe. */
  subscribeBoard(cb: () => void): () => void {
    this.boardSubscribers.add(cb);
    return () => {
      this.boardSubscribers.delete(cb);
    };
  }

  private emitBoardChanged(): void {
    for (const cb of this.boardSubscribers) {
      try {
        cb();
      } catch {
        /* a dead subscriber must not break the others */
      }
    }
  }

  /** Snapshot of a session's buffered events (execution or plan run). */
  getSessionLogs(issueId: string): AgentEvent[] {
    const entry =
      this.state.running.get(issueId) ??
      this.state.planRuns.get(issueId)?.run ??
      this.state.orderRuns.get(issueId)?.run;
    return entry?.eventBuffer.slice() ?? [];
  }

  /** List currently-running sessions for the dashboard. */
  listSessions(): SessionInfo[] {
    return [...this.state.running.values()].map((e) => {
      const todos = latestTodos(e.eventBuffer);
      return {
        issue_id: e.issue.id,
        issue_identifier: e.identifier,
        state: e.issue.state,
        session_id: e.sessionId,
        tmux_session: e.tmuxSession,
        pid: e.pid,
        backend: this.backend.kind,
        started_at: new Date(e.startedAt).toISOString(),
        last_event: e.lastEvent,
        last_event_at: e.lastEventAt !== null ? new Date(e.lastEventAt).toISOString() : null,
        last_action: lastActionLabel(e.eventBuffer),
        turn_count: e.turnCount,
        continuation_count: this.state.continuations.get(e.issue.id) ?? 0,
        workspace_path: e.workspacePath,
        tokens: {
          input_tokens: e.tokens.inputTokens,
          output_tokens: e.tokens.outputTokens,
          total_tokens: e.tokens.totalTokens,
          cost_usd: e.tokens.costUsd,
        },
        todos,
        todo_progress: todos
          ? { done: todos.filter((t) => t.status === 'completed').length, total: todos.length }
          : null,
      };
    });
  }

  /** Static run-wide constants the dashboard renders (capacity, caps, backend). */
  runtimeInfo(): RuntimeInfo {
    return {
      backend: this.backend.kind,
      branch_prefix: this.config.workspace.branch_prefix,
      max_concurrent_agents: this.config.agent.max_concurrent_agents,
      poll_interval_ms: this.config.polling.interval_ms,
      max_turns: this.config.agent.max_turns,
      max_continuations: this.config.agent.max_continuations,
      stall_timeout_ms: this.config.agent.stall_timeout_ms,
      active_states: this.config.tracker.active_states,
      terminal_states: this.config.tracker.terminal_states,
      review_state: this.config.tracker.review_state,
      backlog_state: this.config.tracker.backlog_state,
      in_progress_state: this.config.tracker.in_progress_state,
      workspace_mode: this.config.workspace.mode,
    };
  }

  // ---- serial mutation queue ----

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // Every mutation runs through enqueue; notify board subscribers once it settles so the dashboard
    // refetches live (SSE) instead of waiting for its poll.
    this.queue = next.then(
      () => this.emitBoardChanged(),
      () => this.emitBoardChanged(),
    );
    return next;
  }

  // ---- tick scheduling ----

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    if (this.state.tickTimer) clearTimeout(this.state.tickTimer);
    this.state.tickTimer = setTimeout(() => {
      void this.enqueue(() => this.cycle()).finally(() => {
        if (this.running) this.scheduleTick(this.config.polling.interval_ms);
      });
    }, delayMs);
  }

  // ---- the poll-and-dispatch cycle ----

  private async cycle(): Promise<void> {
    this.state.pollCheckInProgress = true;
    try {
      this.refreshConfig();
      await this.reconcile();

      const pre = dispatchPreflight(this.config, this.detection);
      if (!pre.ok) {
        this.logger.warn({ errors: pre.errors }, 'dispatch preflight failed; skipping dispatch');
        return;
      }

      let candidates: NormalizedIssue[];
      try {
        candidates = await this.tracker.fetchCandidateIssues();
      } catch (e) {
        this.logger.warn({ error: String(e) }, 'fetchCandidateIssues failed; skipping tick');
        return;
      }

      for (const issue of sortForDispatch(candidates)) {
        if (this.availableSlots() <= 0) break;
        if (this.shouldDispatch(issue)) await this.dispatch(issue, 0);
      }
    } finally {
      this.state.pollCheckInProgress = false;
    }
  }

  private refreshConfig(): void {
    if (!this.reload) return;
    const next = this.reload();
    if (!next) return;
    const cur = this.config;
    const r = next.config;
    // Project/repo scope (tracker.project_id/data_root + workspace.mode/repo/root) is owned by
    // switchProject (and applySettings for mode). A hot reload applies everything else — agent,
    // polling, states, hooks, prompt — but never re-points the active project or workspace topology
    // out from under the live tracker/workspace manager (a plain config swap wouldn't rebuild them,
    // and a stale reload mid-switch must not revert the switch).
    this.config = {
      ...r,
      tracker: {
        ...r.tracker,
        ...(cur.tracker.project_id !== undefined ? { project_id: cur.tracker.project_id } : {}),
        ...(cur.tracker.data_root !== undefined ? { data_root: cur.tracker.data_root } : {}),
      },
      workspace: {
        ...r.workspace,
        mode: cur.workspace.mode,
        root: cur.workspace.root,
        ...(cur.workspace.repo !== undefined ? { repo: cur.workspace.repo } : {}),
      },
    };
    this.promptBuilder = new PromptBuilder(next.promptBody);
  }

  // ---- dispatch decisions ----

  private availableSlots(): number {
    // Plan + order runs share the execution concurrency budget (so single_dir never overlaps two
    // runs in the same dir, and worktree mode respects max_concurrent_agents overall). An order run
    // holds ONE slot regardless of how many tickets it sequences.
    const busy = this.state.running.size + this.state.planRuns.size + this.state.orderRuns.size;
    // single_dir mode runs ONE task at a time (the agent works directly in the project dir).
    if (this.config.workspace.mode === 'single_dir') return busy > 0 ? 0 : 1;
    return Math.max(this.config.agent.max_concurrent_agents - busy, 0);
  }

  private runningCountForState(state: string): number {
    let n = 0;
    for (const e of this.state.running.values()) if (e.issue.state === state) n += 1;
    return n;
  }

  private maxForState(state: string): number {
    const byState = this.config.agent.max_concurrent_agents_by_state[state.toLowerCase()];
    return byState ?? this.config.agent.max_concurrent_agents;
  }

  private shouldDispatch(issue: NormalizedIssue): boolean {
    const active = new Set(this.config.tracker.active_states);
    const terminal = new Set(this.config.tracker.terminal_states);
    if (!hasRequiredFields(issue)) return false;
    if (!active.has(issue.state) || terminal.has(issue.state)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;
    if (this.state.blocked.has(issue.id)) return false;
    if (this.paused.has(issue.id)) return false;
    if (this.runningCountForState(issue.state) >= this.maxForState(issue.state)) return false;
    // Sequencing dependency gate: skip a ticket whose blockers are not all terminal. Independent
    // ready tickets later in the sort still dispatch (the loop continues, not breaks). `blockedBy`
    // is `[]` for non-sequenced tickets, so this is inert until the Sequence feature populates it.
    if (blockedByNonTerminal(issue, terminal)) return false;
    return true;
  }

  /**
   * On a fresh pickup from the entry lane, immediately move the issue to the configured in-progress
   * state so the board reflects that an agent is working (instead of the card lingering in the entry
   * lane until the agent moves it). Awaited (the orchestrator is the single file writer, so this
   * serializes with the agent's later writes) so the board-changed event fires only after the write
   * lands and the dashboard refetches the in-progress state. Scoped to the entry state only — never
   * stomps agent-advanced states on continuations/restarts. If the write fails, the local view
   * self-corrects on the next reconcile and the agent still moves the issue itself.
   */
  private async markInProgressOnPickup(issue: NormalizedIssue, entry: RunningEntry): Promise<void> {
    const t = this.config.tracker;
    const target = t.in_progress_state;
    const entryState = t.active_states[0];
    if (
      target === '' ||
      entryState === undefined ||
      issue.state !== entryState ||
      issue.state === target ||
      !t.active_states.includes(target)
    )
      return;
    if (!supportsIssueWriter(this.tracker)) return;
    const tracker = this.tracker;
    // Reflect locally first so per-state counting + reconcile see the in-progress state immediately.
    entry.issue.state = target;
    try {
      await tracker.updateIssueState(issue.id, target);
    } catch (e: unknown) {
      this.logger.warn(
        { issue_id: issue.id, issue_identifier: issue.identifier, error: String(e) },
        'auto-move to in-progress on pickup failed; agent will move it instead',
      );
    }
  }

  /**
   * Persist this worker run's accumulated tokens/cost onto the issue, ADDED to any usage already
   * recorded on the task, so continuation/retry re-dispatches accumulate. Best-effort — a tracker
   * without the writer, or a transient failure, must never break the run. This is the orchestrator's
   * 4th (and only metadata) tracker write-spot (see CLAUDE.md Invariants).
   */
  private async persistUsage(entry: RunningEntry, log: Logger): Promise<void> {
    const t = entry.tokens;
    if (t.inputTokens === 0 && t.outputTokens === 0 && t.totalTokens === 0 && t.costUsd === 0)
      return;
    if (!supportsIssueWriter(this.tracker)) return;
    const tracker = this.tracker;
    const prior = entry.issue.usage;
    const cost = (prior?.costUsd ?? 0) + t.costUsd;
    const usage: IssueUsage = {
      inputTokens: (prior?.inputTokens ?? 0) + t.inputTokens,
      outputTokens: (prior?.outputTokens ?? 0) + t.outputTokens,
      totalTokens: (prior?.totalTokens ?? 0) + t.totalTokens,
      ...(cost > 0 ? { costUsd: cost } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
    // Carry forward in-memory so a continuation re-dispatch of this same issue object accumulates.
    entry.issue.usage = usage;
    try {
      await tracker.updateIssue(entry.issue.id, { usage });
    } catch (e: unknown) {
      log.warn({ error: String(e) }, 'failed to persist task token usage');
    }
  }

  private async dispatch(issue: NormalizedIssue, attempt: number): Promise<void> {
    const entry = newRunningEntry(issue, attempt, this.now());
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retryAttempts.delete(issue.id);
    // attempt 0 == fresh poll dispatch (not a continuation/failure retry): reset the run of
    // consecutive continuations so the cap only counts uninterrupted continuation re-dispatches.
    if (attempt === 0) this.state.continuations.delete(issue.id);
    // attempt 0 starts cold; re-dispatches (continuation / failure retry) resume the carried session.
    if (attempt === 0) this.state.resumeSessions.delete(issue.id);
    if (attempt === 0) await this.markInProgressOnPickup(issue, entry);
    const resumeSessionId = attempt > 0 ? this.state.resumeSessions.get(issue.id) : undefined;

    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    log.info({ attempt, ...(resumeSessionId ? { resuming: true } : {}) }, 'dispatching issue');

    const ctx = {
      issue,
      attempt: attempt === 0 ? null : attempt,
      signal: entry.abort.signal,
      emit: (ev: AgentEvent) => this.onAgentEvent(entry, ev),
      onSession: (sid: string) => {
        entry.sessionId = sid;
      },
      onWorktree: (p: string) => {
        entry.workspacePath = p;
      },
      onProcess: (info: { pid?: number; tmuxSession?: string }) => {
        if (info.pid !== undefined) entry.pid = info.pid;
        if (info.tmuxSession !== undefined) entry.tmuxSession = info.tmuxSession;
      },
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    };
    // Seed the running entry's sessionId too, so the dashboard shows continuity immediately.
    if (resumeSessionId !== undefined) entry.sessionId = resumeSessionId;

    void runWorker(
      {
        tracker: this.tracker,
        workspaceManager: this.workspaceManager,
        promptBuilder: this.promptBuilder,
        backend: this.backend,
        config: this.config,
        ...(this.mcpConfig !== undefined ? { mcpConfig: this.mcpConfig } : {}),
      },
      ctx,
    ).then(
      (outcome) => this.enqueue(() => this.onWorkerExit(issue.id, outcome)),
      (err) =>
        this.enqueue(() => this.onWorkerExit(issue.id, { kind: 'failed', error: String(err) })),
    );
  }

  private onAgentEvent(entry: RunningEntry, ev: AgentEvent): void {
    entry.lastEvent = ev.type;
    entry.lastEventAt = this.now();
    entry.eventBuffer.push(ev);
    if (entry.eventBuffer.length > EVENT_BUFFER_CAP) entry.eventBuffer.shift();
    if (ev.type === 'turn_completed') entry.turnCount += 1;
    if (ev.type === 'usage') {
      const delta = integrateUsage(entry.tokens, ev);
      this.state.totals.inputTokens += delta.inputTokens;
      this.state.totals.outputTokens += delta.outputTokens;
      this.state.totals.totalTokens += delta.totalTokens;
      this.state.totals.costUsd += delta.costUsd;
      if (ev.rateLimits !== undefined) this.state.rateLimits = ev.rateLimits;
    }
    const subs = this.logSubscribers.get(entry.issue.id);
    if (subs) for (const cb of subs) cb(ev);
  }

  // ---- worker exit ----

  private async onWorkerExit(issueId: string, outcome: WorkerOutcome): Promise<void> {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    this.state.running.delete(issueId);
    this.state.totals.secondsRunning += (this.now() - entry.startedAt) / 1000;
    const log = this.logger.child({ issue_id: issueId, issue_identifier: entry.identifier });

    // Persist this run's accumulated tokens/cost onto the task (best-effort) so the count survives
    // worker exit + restart and shows on completed tickets. Done for every disposition.
    await this.persistUsage(entry, log);

    // During shutdown, do not schedule further retries/blocks — just release.
    if (this.stopping) {
      this.stopIntents.delete(issueId);
      this.state.claimed.delete(issueId);
      this.state.resumeSessions.delete(issueId);
      return;
    }

    const intent = this.stopIntents.get(issueId);
    if (intent) {
      this.stopIntents.delete(issueId);
      if (intent === 'terminal') {
        this.state.claimed.delete(issueId);
        this.state.continuations.delete(issueId);
        this.state.resumeSessions.delete(issueId);
        await this.finalizeTerminal(entry.issue);
        log.info({}, 'stopped: terminal state; workspace finalized');
      } else if (intent === 'nonactive') {
        this.state.claimed.delete(issueId);
        this.state.continuations.delete(issueId);
        this.state.resumeSessions.delete(issueId);
        log.info({}, 'stopped: non-active state');
      } else if (intent === 'manual') {
        // Operator terminate: release claim, keep the workspace, no retry. The
        // `paused` set (added by terminate) holds it back from re-dispatch.
        this.state.claimed.delete(issueId);
        this.state.continuations.delete(issueId);
        this.state.resumeSessions.delete(issueId);
        log.info({}, 'stopped: operator terminated; held from re-dispatch');
      } else {
        // Stall = idle timeout: retryable, bounded by the cap. Carry the session so the retry
        // resumes the agent's work rather than restarting cold (idle is a transient interruption).
        if (this.sideEffectSeen(entry)) this.rememberResume(entry);
        this.failOrBlock(entry.issue, entry.retryAttempt + 1, {
          error: 'stall',
          category: 'idle_timeout',
          retryable: true,
        });
      }
      return;
    }

    switch (outcome.kind) {
      case 'aborted':
        this.state.claimed.delete(issueId);
        this.state.resumeSessions.delete(issueId);
        return;
      case 'blocked':
        this.state.resumeSessions.delete(issueId);
        this.state.blocked.set(issueId, {
          issue: entry.issue,
          identifier: entry.identifier,
          reason: outcome.reason,
          blockedAt: this.now(),
        });
        log.warn({ reason: outcome.reason }, 'issue blocked on operator input');
        return;
      case 'completed': {
        switch (outcome.disposition) {
          case 'terminal':
            this.state.completed.add(issueId);
            this.state.claimed.delete(issueId);
            this.state.continuations.delete(issueId);
            this.state.resumeSessions.delete(issueId);
            await this.finalizeTerminal(entry.issue);
            log.info({}, 'turn completed; issue terminal, workspace finalized');
            return;
          case 'nonactive':
            this.state.claimed.delete(issueId);
            this.state.continuations.delete(issueId);
            this.state.resumeSessions.delete(issueId);
            log.info({}, 'turn completed; issue left active, released');
            return;
          case 'exhausted': {
            const continuations = (this.state.continuations.get(issueId) ?? 0) + 1;
            const cap = this.config.agent.max_continuations;
            if (cap > 0 && continuations >= cap) {
              this.state.continuations.delete(issueId);
              this.state.resumeSessions.delete(issueId);
              this.state.blocked.set(issueId, {
                issue: entry.issue,
                identifier: entry.identifier,
                reason: 'continuation cap reached without terminal state',
                blockedAt: this.now(),
              });
              log.warn(
                { continuations, cap },
                'continuation cap reached; blocking issue for operator input',
              );
              return;
            }
            this.state.continuations.set(issueId, continuations);
            this.state.completed.add(issueId);
            // The turn succeeded with work done → resume its session on the continuation re-dispatch
            // so the agent keeps its file/tool memory instead of re-deriving from the prompt.
            this.rememberResume(entry);
            this.scheduleRetry(entry.issue, 1, 'continuation');
            log.info({ continuations }, 'turn completed; continuation re-check scheduled');
            return;
          }
        }
        return;
      }
      case 'failed': {
        // Resume-on-failure: carry the session forward only when the failure is transient AND the
        // run did real work (a tool ran). Otherwise restart cold. failOrBlock clears it if it blocks.
        const resumable = outcome.retryable !== false && this.sideEffectSeen(entry);
        if (resumable) this.rememberResume(entry);
        else this.state.resumeSessions.delete(issueId);
        this.failOrBlock(entry.issue, entry.retryAttempt + 1, {
          error: outcome.error,
          ...(outcome.category !== undefined ? { category: outcome.category } : {}),
          ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
        });
        return;
      }
    }
  }

  /** Persist the entry's agent session id so the next re-dispatch resumes it (no-op if unset). */
  private rememberResume(entry: RunningEntry): void {
    if (entry.sessionId) this.state.resumeSessions.set(entry.issue.id, entry.sessionId);
  }

  /** Whether the run did observable work this attempt (a tool ran) — gates resume-on-failure. */
  private sideEffectSeen(entry: RunningEntry): boolean {
    return entry.eventBuffer.some((e) => e.type === 'tool_use' || e.type === 'tool_result');
  }

  /**
   * Decide what to do with a failed attempt: schedule a (jittered) retry, or — when the failure
   * is non-retryable (permanent category) or the failure-retry cap is exhausted — move the issue
   * to `blocked` for operator attention instead of retrying forever. Mirrors open-design's
   * `retryable`/`user_action` gate. `retryable === false` ⇒ permanent; `cap === 0` ⇒ unlimited.
   */
  private failOrBlock(
    issue: NormalizedIssue,
    nextAttempt: number,
    opts: { error: string; category?: ErrorCategory; retryable?: boolean },
  ): void {
    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    const cap = this.config.agent.max_failure_retries;
    const permanent = opts.retryable === false;
    const capExceeded = cap > 0 && nextAttempt > cap;
    if (permanent || capExceeded) {
      const reason = permanent
        ? `non-retryable failure${opts.category ? ` (${opts.category})` : ''}: ${opts.error}`
        : `failed after ${cap} retr${cap === 1 ? 'y' : 'ies'}: ${opts.error}`;
      const existing = this.state.retryAttempts.get(issue.id);
      if (existing) clearTimeout(existing.timer);
      this.state.retryAttempts.delete(issue.id);
      this.state.continuations.delete(issue.id);
      this.state.resumeSessions.delete(issue.id);
      this.state.blocked.set(issue.id, {
        issue,
        identifier: issue.identifier,
        reason,
        blockedAt: this.now(),
      });
      log.warn(
        { ...(opts.category ? { category: opts.category } : {}), attempt: nextAttempt, cap },
        permanent
          ? 'non-retryable failure; blocking for operator input'
          : 'retry cap reached; blocking for operator input',
      );
      return;
    }
    this.scheduleRetry(issue, nextAttempt, 'failure', opts.error);
    log.warn(
      {
        error: opts.error,
        ...(opts.category ? { category: opts.category } : {}),
        attempt: nextAttempt,
      },
      'attempt failed; scheduled retry',
    );
  }

  // ---- retries ----

  private scheduleRetry(
    issue: NormalizedIssue,
    attempt: number,
    delayType: 'continuation' | 'failure',
    error?: string,
  ): void {
    const existing = this.state.retryAttempts.get(issue.id);
    if (existing) clearTimeout(existing.timer);
    const delay = retryDelay(attempt, delayType, this.config.agent.max_retry_backoff_ms);
    const timer = setTimeout(() => {
      void this.enqueue(() => this.onRetryTimer(issue.id));
    }, delay);
    this.state.retryAttempts.set(issue.id, {
      issue,
      identifier: issue.identifier,
      attempt,
      dueAtMs: this.now() + delay,
      timer,
      delayType,
      ...(error !== undefined ? { error } : {}),
    });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const r = this.state.retryAttempts.get(issueId);
    if (!r) return;
    this.state.retryAttempts.delete(issueId);
    const active = new Set(this.config.tracker.active_states);

    let candidates: NormalizedIssue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch {
      this.scheduleRetry(r.issue, r.attempt, 'failure', 'candidate refetch failed');
      return;
    }

    const fresh = candidates.find((c) => c.id === issueId);
    if (!fresh || !active.has(fresh.state)) {
      this.state.claimed.delete(issueId);
      this.state.continuations.delete(issueId);
      return;
    }
    if (this.availableSlots() > 0) {
      await this.dispatch(fresh, r.attempt);
    } else {
      this.scheduleRetry(fresh, r.attempt, 'failure', 'no available orchestrator slots');
    }
  }

  // ---- reconciliation ----

  private async reconcile(): Promise<void> {
    this.reconcileStalls();
    await this.reconcileRunningStates();
    await this.reconcileBlocked();
  }

  private reconcileStalls(): void {
    const stallMs = this.config.agent.stall_timeout_ms;
    if (stallMs <= 0) return;
    const now = this.now();
    for (const [id, entry] of this.state.running) {
      if (this.stopIntents.has(id)) continue;
      const last = entry.lastEventAt ?? entry.startedAt;
      if (now - last > stallMs) {
        this.stopIntents.set(id, 'stall');
        entry.abort.abort();
      }
    }
  }

  private async reconcileRunningStates(): Promise<void> {
    const ids = [...this.state.running.keys()];
    if (ids.length === 0) return;
    const terminal = new Set(this.config.tracker.terminal_states);
    const active = new Set(this.config.tracker.active_states);

    let refs;
    try {
      refs = await this.tracker.fetchIssueStatesByIds(ids);
    } catch (e) {
      this.logger.warn({ error: String(e) }, 'reconcile state refresh failed; keeping workers');
      return;
    }
    const byId = new Map(refs.map((r) => [r.id, r]));
    for (const [id, entry] of this.state.running) {
      if (this.stopIntents.has(id)) continue;
      const ref = byId.get(id);
      if (!ref) {
        this.stopIntents.set(id, 'nonactive');
        entry.abort.abort();
      } else if (terminal.has(ref.state)) {
        this.stopIntents.set(id, 'terminal');
        entry.abort.abort();
      } else if (active.has(ref.state)) {
        entry.issue.state = ref.state;
      } else {
        this.stopIntents.set(id, 'nonactive');
        entry.abort.abort();
      }
    }
  }

  private async reconcileBlocked(): Promise<void> {
    const ids = [...this.state.blocked.keys()];
    if (ids.length === 0) return;
    const terminal = new Set(this.config.tracker.terminal_states);
    const active = new Set(this.config.tracker.active_states);

    let refs;
    try {
      refs = await this.tracker.fetchIssueStatesByIds(ids);
    } catch {
      return;
    }
    const byId = new Map(refs.map((r) => [r.id, r]));
    for (const [id, entry] of this.state.blocked) {
      const ref = byId.get(id);
      if (!ref || (!active.has(ref.state) && !terminal.has(ref.state)) || terminal.has(ref.state)) {
        this.state.blocked.delete(id);
        this.state.claimed.delete(id);
        if (ref && terminal.has(ref.state)) await this.finalizeTerminal(entry.issue, ref.state);
      }
    }
  }

  // ---- terminal integration (merge-on-accept) ----

  /** Cancel-type terminals (Cancelled/Canceled/Duplicate) are discarded, never merged. */
  private isCancelState(name: string): boolean {
    return /cancel|duplicate/i.test(name);
  }

  /**
   * Integrate + clean up an issue that reached a terminal state. Completed-type terminals (Done/
   * Closed) merge the issue's work into the base branch first so the next worktree builds on top;
   * cancel-type (Discard) just clean up. On a merge conflict the work is preserved (worktree + branch
   * kept) and surfaced via `mergeFailures` + a tracker comment. single_dir's integrate() is a no-op.
   */
  private async finalizeTerminal(
    issue: NormalizedIssue,
    terminalStateName?: string,
  ): Promise<void> {
    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    let stateName = terminalStateName;
    if (stateName === undefined) {
      const refs = await this.tracker.fetchIssueStatesByIds([issue.id]).catch(() => []);
      stateName = refs.find((r) => r.id === issue.id)?.state;
    }
    if (stateName === undefined || !this.isCancelState(stateName)) {
      let res: { merged: boolean; conflict?: boolean; reason?: string };
      try {
        res = await this.workspaceManager.integrate(issue);
      } catch (e) {
        res = { merged: false, conflict: true, reason: String(e) };
      }
      if (res.conflict) {
        const reason = res.reason ?? 'merge conflict on accept';
        this.mergeFailures.set(issue.id, {
          issue,
          identifier: issue.identifier,
          reason,
          at: this.now(),
        });
        const tracker = this.tracker;
        if (supportsIssueWriter(tracker)) {
          await tracker
            .addComment(
              issue.id,
              `⚠️ Auto-merge on accept failed: ${reason}. The branch is preserved — merge it manually.`,
            )
            .catch(() => undefined);
        }
        log.warn({ reason }, 'auto-merge on accept failed; branch + worktree preserved');
        return; // keep the worktree + branch for manual resolution
      }
      this.mergeFailures.delete(issue.id);
      if (res.merged) log.info({}, 'merged issue branch into base on accept');
    }
    await this.workspaceManager.cleanup(issue).catch(() => undefined);
  }

  /**
   * Finalize an operator state change made directly via the dashboard (e.g. Accept moves a parked
   * review ticket to Done). Reconcile loops only see tracked issues, so a terminal move on an
   * untracked issue (not running/claimed/blocked) is integrated + cleaned up here. Tracked issues are
   * finalized by their normal exit/reconcile path, so skip them to avoid double-work.
   */
  async onExternalMove(issueId: string): Promise<void> {
    return this.enqueue(async () => {
      if (
        this.state.running.has(issueId) ||
        this.state.claimed.has(issueId) ||
        this.state.blocked.has(issueId)
      )
        return;
      const tracker = this.tracker;
      if (!supportsBoard(tracker)) return;
      const terminal = new Set(this.config.tracker.terminal_states);
      const issue = (await tracker.fetchAllIssues().catch(() => [])).find((i) => i.id === issueId);
      if (!issue || !terminal.has(issue.state)) return;
      await this.finalizeTerminal(issue, issue.state);
    });
  }

  // ---- observability ----

  snapshot() {
    return {
      generated_at: new Date(this.now()).toISOString(),
      counts: {
        running: this.state.running.size,
        claimed: this.state.claimed.size,
        blocked: this.state.blocked.size,
        retrying: this.state.retryAttempts.size,
        completed: this.state.completed.size,
        paused: this.paused.size,
      },
      paused: [...this.paused],
      running: [...this.state.running.values()].map((e) => ({
        issue_id: e.issue.id,
        issue_identifier: e.identifier,
        state: e.issue.state,
        session_id: e.sessionId,
        workspace_path: e.workspacePath,
        turn_count: e.turnCount,
        last_event: e.lastEvent,
        started_at: new Date(e.startedAt).toISOString(),
        tokens: {
          input_tokens: e.tokens.inputTokens,
          output_tokens: e.tokens.outputTokens,
          total_tokens: e.tokens.totalTokens,
          cost_usd: e.tokens.costUsd,
        },
      })),
      blocked: [...this.state.blocked.values()].map((b) => ({
        issue_id: b.issue.id,
        issue_identifier: b.identifier,
        reason: b.reason,
        blocked_at: new Date(b.blockedAt).toISOString(),
      })),
      retrying: [...this.state.retryAttempts.values()].map((r) => ({
        issue_id: r.issue.id,
        issue_identifier: r.identifier,
        attempt: r.attempt,
        delay_type: r.delayType,
        due_at: new Date(r.dueAtMs).toISOString(),
        error: r.error ?? null,
      })),
      merge_failures: [...this.mergeFailures.values()].map((m) => ({
        issue_id: m.issue.id,
        issue_identifier: m.identifier,
        reason: m.reason,
        at: new Date(m.at).toISOString(),
      })),
      codex_totals: {
        input_tokens: this.state.totals.inputTokens,
        output_tokens: this.state.totals.outputTokens,
        total_tokens: this.state.totals.totalTokens,
        cost_usd: this.state.totals.costUsd,
        seconds_running: this.state.totals.secondsRunning,
      },
      rate_limits: this.state.rateLimits,
    };
  }

  /** Look up a single issue across running/blocked/retry (dashboard detail). */
  findIssue(identifier: string) {
    const snap = this.snapshot();
    return (
      snap.running.find((r) => r.issue_identifier === identifier) ??
      snap.blocked.find((b) => b.issue_identifier === identifier) ??
      snap.retrying.find((r) => r.issue_identifier === identifier) ??
      null
    );
  }
}

export type OrchestratorSnapshot = ReturnType<Orchestrator['snapshot']>;

export interface SessionInfo {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  tmux_session: string | null;
  pid: number | null;
  /** Backend kind driving this session (e.g. claude-sdk, claude-cli, codex-cli). */
  backend: string;
  started_at: string;
  last_event: string | null;
  /** ISO timestamp of the most recent agent event (drives the stall watchdog). */
  last_event_at: string | null;
  /** Human label for the most recent meaningful action (e.g. "Edit: index.ts"). */
  last_action: string | null;
  turn_count: number;
  /** Consecutive continuation re-dispatches for this issue (0 on a fresh dispatch). */
  continuation_count: number;
  workspace_path: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** Equivalent API cost in USD accrued so far this run (from the SDK's total_cost_usd). */
    cost_usd: number;
  };
  /** The agent's own plan: its latest TodoWrite todo list (null until it writes one). */
  todos: TodoItem[] | null;
  /** Compact progress over `todos` (completed/total); null when the agent has no todos. */
  todo_progress: { done: number; total: number } | null;
}

/** One item from the agent's own TodoWrite plan, surfaced live on the dashboard. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-tense form Claude Code shows while the item is in progress (optional). */
  activeForm?: string;
}

/** Run-wide constants the dashboard renders (capacity gauge, caps, configured backend). */
export interface RuntimeInfo {
  backend: string;
  /** Git branch prefix (e.g. "symphony/"); branch = `${branch_prefix}${identifier}`. */
  branch_prefix: string;
  max_concurrent_agents: number;
  poll_interval_ms: number;
  max_turns: number;
  max_continuations: number;
  stall_timeout_ms: number;
  /** Workflow state classification (state names) so the dashboard can resolve review/rework/terminal
   *  targets and gate the review-actions UI without hardcoding state names. */
  active_states: string[];
  terminal_states: string[];
  review_state: string;
  /** Leftmost non-active lane (e.g. "Backlog"); used to derive the board's visible lane set. */
  backlog_state: string;
  /** State an issue moves to on pickup (e.g. "In Progress"); the rework action also targets it. */
  in_progress_state: string;
  /** Active workspace mode (`single_dir` | `worktree`) for the settings toggle + board hints. */
  workspace_mode: string;
}

function summarizeActionArg(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** Parse a TodoWrite tool input into normalized todo items (null if it isn't a todo payload). */
function parseTodos(input: unknown): TodoItem[] | null {
  if (input === null || typeof input !== 'object') return null;
  // `todos` arrives either as an array or as a JSON-encoded string (the CLI/deferred-tool path
  // stringifies tool args) — accept both.
  let raw = (input as { todos?: unknown }).todos;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (t === null || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o.content !== 'string' || o.content.trim() === '') continue;
    const status =
      o.status === 'in_progress' || o.status === 'completed' ? o.status : ('pending' as const);
    out.push({
      content: o.content,
      status,
      ...(typeof o.activeForm === 'string' ? { activeForm: o.activeForm } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * The agent's current plan: the todos from the most recent TodoWrite tool_use in the buffer, or null.
 * Surfaced on the dashboard so the operator can watch the agent's self-managed plan progress.
 */
export function latestTodos(buffer: AgentEvent[]): TodoItem[] | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const ev = buffer[i];
    if (ev === undefined || ev.type !== 'tool_use' || ev.toolName !== 'TodoWrite') continue;
    const todos = parseTodos(ev.input);
    if (todos) return todos;
  }
  return null;
}

/** Most recent meaningful action from a session's event buffer, for card/drawer signals. */
export function lastActionLabel(buffer: AgentEvent[]): string | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const ev = buffer[i];
    if (ev === undefined) continue;
    if (ev.type === 'tool_use') {
      const arg = summarizeActionArg(ev.input);
      const label = arg !== undefined ? `${ev.toolName}: ${arg}` : ev.toolName;
      return label.length > 64 ? `${label.slice(0, 63)}…` : label;
    }
    if (ev.type === 'text_delta') {
      const t = ev.text.replace(/\s+/g, ' ').trim();
      if (t !== '') return t.length > 64 ? `${t.slice(0, 63)}…` : t;
    }
  }
  return null;
}
