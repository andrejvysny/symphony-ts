import type { AgentEvent, CodingAgentBackend, McpConfig } from '@symphony/agent-backends';
import type { NormalizedIssue } from '@symphony/shared';
import type { Tracker } from '@symphony/tracker';
import type { SymphonyConfig } from '../config/resolve.js';
import { dispatchPreflight } from '../config/validate.js';
import { type Logger, noopLogger } from '../observability/logger.js';
import { PromptBuilder } from '../prompt/builder.js';
import type { IWorkspaceManager } from '../workspace/manager.js';
import {
  hasRequiredFields,
  retryDelay,
  sortForDispatch,
  todoBlockedByNonTerminal,
} from './dispatch.js';
import {
  createState,
  EVENT_BUFFER_CAP,
  newRunningEntry,
  type OrchestratorState,
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
  /** MCP servers (e.g. linear_graphql) passed to every agent run. */
  mcpConfig?: McpConfig;
  /** Hot-reload hook: returns the latest config + prompt body, or null to keep current. */
  reload?: () => { config: SymphonyConfig; promptBody: string } | null;
  /** Injectable clock (tests). */
  now?: () => number;
}

type StopIntent = 'terminal' | 'nonactive' | 'stall' | 'manual';

export class Orchestrator {
  private readonly state: OrchestratorState = createState();
  private readonly tracker: Tracker;
  private readonly backend: CodingAgentBackend;
  private readonly workspaceManager: IWorkspaceManager;
  private readonly logger: Logger;
  private readonly reload:
    | (() => { config: SymphonyConfig; promptBody: string } | null)
    | undefined;
  private readonly now: () => number;
  private promptBuilder: PromptBuilder;
  private config: SymphonyConfig;
  private readonly mcpConfig: McpConfig | undefined;
  private readonly stopIntents = new Map<string, StopIntent>();
  /** Operator-terminated issues held back from re-dispatch until moved/resumed. */
  private readonly paused = new Set<string>();
  /** Per-issue live-log subscribers (SSE). */
  private readonly logSubscribers = new Map<string, Set<(ev: AgentEvent) => void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private stopping = false;

  constructor(deps: OrchestratorDeps) {
    this.tracker = deps.tracker;
    this.backend = deps.backend;
    this.workspaceManager = deps.workspaceManager;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
    this.reload = deps.reload;
    this.now = deps.now ?? (() => Date.now());
    this.promptBuilder = deps.promptBuilder ?? new PromptBuilder('');
    this.mcpConfig = deps.mcpConfig;
  }

  // ---- public lifecycle ----

  start(): void {
    this.running = true;
    void this.enqueue(() => this.startupCleanup()).finally(() => this.scheduleTick(0));
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

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.state.tickTimer) clearTimeout(this.state.tickTimer);
    this.state.tickTimer = null;
    for (const r of this.state.retryAttempts.values()) clearTimeout(r.timer);
    this.state.retryAttempts.clear();
    for (const entry of this.state.running.values()) entry.abort.abort();
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

  /** Subscribe to a running session's live events; replays the buffer first. Returns unsubscribe. */
  subscribeLogs(issueId: string, cb: (ev: AgentEvent) => void): () => void {
    const entry = this.state.running.get(issueId);
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

  /** Snapshot of a session's buffered events. */
  getSessionLogs(issueId: string): AgentEvent[] {
    return this.state.running.get(issueId)?.eventBuffer.slice() ?? [];
  }

  /** List currently-running sessions for the dashboard. */
  listSessions(): SessionInfo[] {
    return [...this.state.running.values()].map((e) => ({
      issue_id: e.issue.id,
      issue_identifier: e.identifier,
      state: e.issue.state,
      session_id: e.sessionId,
      tmux_session: e.tmuxSession,
      pid: e.pid,
      started_at: new Date(e.startedAt).toISOString(),
      last_event: e.lastEvent,
      turn_count: e.turnCount,
      workspace_path: e.workspacePath,
      tokens: {
        input_tokens: e.tokens.inputTokens,
        output_tokens: e.tokens.outputTokens,
        total_tokens: e.tokens.totalTokens,
      },
    }));
  }

  // ---- serial mutation queue ----

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
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

      const pre = dispatchPreflight(this.config);
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
        if (this.shouldDispatch(issue)) this.dispatch(issue, 0);
      }
    } finally {
      this.state.pollCheckInProgress = false;
    }
  }

  private refreshConfig(): void {
    if (!this.reload) return;
    const next = this.reload();
    if (next) {
      this.config = next.config;
      this.promptBuilder = new PromptBuilder(next.promptBody);
    }
  }

  // ---- dispatch decisions ----

  private availableSlots(): number {
    return Math.max(this.config.agent.max_concurrent_agents - this.state.running.size, 0);
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
    if (issue.state.toLowerCase() === 'todo' && todoBlockedByNonTerminal(issue, terminal))
      return false;
    return true;
  }

  private dispatch(issue: NormalizedIssue, attempt: number): void {
    const entry = newRunningEntry(issue, attempt, this.now());
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retryAttempts.delete(issue.id);
    // attempt 0 == fresh poll dispatch (not a continuation/failure retry): reset the run of
    // consecutive continuations so the cap only counts uninterrupted continuation re-dispatches.
    if (attempt === 0) this.state.continuations.delete(issue.id);

    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    log.info({ attempt }, 'dispatching issue');

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
    };

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

    // During shutdown, do not schedule further retries/blocks — just release.
    if (this.stopping) {
      this.stopIntents.delete(issueId);
      this.state.claimed.delete(issueId);
      return;
    }

    const intent = this.stopIntents.get(issueId);
    if (intent) {
      this.stopIntents.delete(issueId);
      if (intent === 'terminal') {
        this.state.claimed.delete(issueId);
        this.state.continuations.delete(issueId);
        await this.workspaceManager.cleanup(entry.issue).catch(() => undefined);
        log.info({}, 'stopped: terminal state; workspace cleaned');
      } else if (intent === 'nonactive') {
        this.state.claimed.delete(issueId);
        this.state.continuations.delete(issueId);
        log.info({}, 'stopped: non-active state');
      } else if (intent === 'manual') {
        // Operator terminate: release claim, keep the workspace, no retry. The
        // `paused` set (added by terminate) holds it back from re-dispatch.
        this.state.claimed.delete(issueId);
        this.state.continuations.delete(issueId);
        log.info({}, 'stopped: operator terminated; held from re-dispatch');
      } else {
        this.scheduleRetry(entry.issue, entry.retryAttempt + 1, 'failure', 'stall');
        log.warn({}, 'stalled; scheduled retry');
      }
      return;
    }

    switch (outcome.kind) {
      case 'aborted':
        this.state.claimed.delete(issueId);
        return;
      case 'blocked':
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
            await this.workspaceManager.cleanup(entry.issue).catch(() => undefined);
            log.info({}, 'turn completed; issue terminal, workspace cleaned');
            return;
          case 'nonactive':
            this.state.claimed.delete(issueId);
            this.state.continuations.delete(issueId);
            log.info({}, 'turn completed; issue left active, released');
            return;
          case 'exhausted': {
            const continuations = (this.state.continuations.get(issueId) ?? 0) + 1;
            const cap = this.config.agent.max_continuations;
            if (cap > 0 && continuations >= cap) {
              this.state.continuations.delete(issueId);
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
            this.scheduleRetry(entry.issue, 1, 'continuation');
            log.info({ continuations }, 'turn completed; continuation re-check scheduled');
            return;
          }
        }
        return;
      }
      case 'failed':
        this.scheduleRetry(entry.issue, entry.retryAttempt + 1, 'failure', outcome.error);
        log.warn(
          { error: outcome.error, ...(outcome.category ? { category: outcome.category } : {}) },
          'attempt failed; scheduled retry',
        );
        return;
    }
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
      this.dispatch(fresh, r.attempt);
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
        if (ref && terminal.has(ref.state))
          await this.workspaceManager.cleanup(entry.issue).catch(() => undefined);
      }
    }
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
      codex_totals: {
        input_tokens: this.state.totals.inputTokens,
        output_tokens: this.state.totals.outputTokens,
        total_tokens: this.state.totals.totalTokens,
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
  started_at: string;
  last_event: string | null;
  turn_count: number;
  workspace_path: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
}
