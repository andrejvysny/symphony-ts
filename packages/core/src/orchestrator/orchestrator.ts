import {
  AGENT_DEFS,
  detectAgent,
  type AgentEvent,
  type CodingAgentBackend,
  type McpConfig,
} from '@symphony/agent-backends';
import type { ErrorCategory, NormalizedIssue } from '@symphony/shared';
import { type Tracker, supportsBoard, supportsIssueWriter } from '@symphony/tracker';
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
      this.state.running.clear();
      this.state.claimed.clear();
      this.state.completed.clear();
      this.state.continuations.clear();
      this.state.resumeSessions.clear();
      this.state.blocked.clear();
      this.stopIntents.clear();
      this.paused.clear();
      this.mergeFailures.clear();
      this.state.totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
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
      },
    }));
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
    if (next) {
      // Workspace topology (mode/repo/root) is owned by applySettings/switchProject — a hot reload must
      // not flip it out from under the live workspace manager (which a plain config swap won't rebuild).
      // Other settings, and non-topology workspace fields, still apply live.
      const prev = this.config.workspace;
      const nw = next.config.workspace;
      const topologyChanged =
        prev.mode !== nw.mode || prev.repo !== nw.repo || prev.root !== nw.root;
      this.config = topologyChanged
        ? {
            ...next.config,
            workspace: { ...nw, mode: prev.mode, repo: prev.repo, root: prev.root },
          }
        : next.config;
      this.promptBuilder = new PromptBuilder(next.promptBody);
    }
  }

  // ---- dispatch decisions ----

  private availableSlots(): number {
    // single_dir mode runs ONE task at a time (the agent works directly in the project dir).
    if (this.config.workspace.mode === 'single_dir') return this.state.running.size > 0 ? 0 : 1;
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
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
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
