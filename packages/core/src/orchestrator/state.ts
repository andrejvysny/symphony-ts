import type { OrderToolDeps, PlanToolDeps } from '@symphony/agent-backends';
import type { AgentEvent } from '@symphony/agent-backends';
import type { NormalizedIssue } from '@symphony/shared';
import type { OrderRunControl } from './order-worker.js';
import type { PlanRunControl } from './plan-worker.js';
import { emptyTokenState, type TokenState } from './token-accounting.js';

/** Cap on the per-session rolling event log retained in memory for live streaming. */
export const EVENT_BUFFER_CAP = 500;

export interface RunningEntry {
  issue: NormalizedIssue;
  identifier: string;
  abort: AbortController;
  workspacePath: string | null;
  sessionId: string | null;
  /** tmux session name when the run is supervised by tmux (CLI backend). */
  tmuxSession: string | null;
  pid: number | null;
  lastEvent: string | null;
  lastEventAt: number | null;
  startedAt: number;
  turnCount: number;
  retryAttempt: number;
  tokens: TokenState;
  /** Rolling buffer of recent agent events for the live-log console (capped). */
  eventBuffer: AgentEvent[];
}

export interface BlockedEntry {
  issue: NormalizedIssue;
  identifier: string;
  reason: string;
  blockedAt: number;
}

/**
 * A live plan run (the read-only "Plan" track, parallel to execution). Wraps a {@link RunningEntry}
 * (so it reuses the same event buffer / token accounting / live-log streaming) plus the shared
 * control flags the MCP tool executors flip, and the run's resolved Q&A mode.
 */
export interface PlanRunEntry {
  run: RunningEntry;
  control: PlanRunControl;
  mode: 'live' | 'pause';
  /** The run's plan-tool executors (also handed to the SDK MCP server). Exposed for tests. */
  deps?: PlanToolDeps;
}

/**
 * A live ordering run (the Sequence track, parallel to execution + plan). Like {@link PlanRunEntry}
 * it wraps a {@link RunningEntry} (whose synthetic issue's id === `runId`, so live-log routing keys
 * by the run, not a ticket) plus the shared control flags + resolved Q&A mode, and remembers the
 * selected subset + operator instructions for re-runs.
 */
export interface OrderRunEntry {
  runId: string;
  /** The selected subset's issue ids (for overlap guards). */
  issueIds: string[];
  run: RunningEntry;
  control: OrderRunControl;
  mode: 'live' | 'pause';
  customInstructions?: string;
  /** The run's order-tool executors (also handed to the SDK MCP server). Exposed for tests. */
  deps?: OrderToolDeps;
}

/**
 * A live-mode `symphony_ask` awaiting an operator answer — resolves the agent's blocked tool call.
 * Carries the owning issue id (plan track) OR run id (order track) so teardown can reject the right
 * subset.
 */
export interface PendingAsk {
  issueId?: string;
  runId?: string;
  /** Resolve with the formatted answer text the agent's tool call returns. */
  resolve: (answersText: string) => void;
  reject: (err: Error) => void;
}

export interface RetryEntry {
  issue: NormalizedIssue;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout;
  delayType: 'continuation' | 'failure';
  error?: string;
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  secondsRunning: number;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  completed: Set<string>;
  /** Consecutive continuation re-dispatches per issue (reset on fresh poll dispatch / terminal). */
  continuations: Map<string, number>;
  blocked: Map<string, BlockedEntry>;
  retryAttempts: Map<string, RetryEntry>;
  /**
   * Per-issue Claude session id carried ACROSS worker re-dispatch (resume-on-failure / continuation),
   * so a re-dispatched worker continues the agent's CLI session instead of restarting cold. Set when
   * a re-dispatch is warranted; cleared when the issue leaves the active pipeline (terminal / blocked
   * / nonactive / fresh poll dispatch).
   */
  resumeSessions: Map<string, string>;
  /** Live plan runs (the read-only "Plan" track), keyed by issue id. Shares the concurrency budget. */
  planRuns: Map<string, PlanRunEntry>;
  /** Live ordering runs (the Sequence track), keyed by run id. Shares the concurrency budget. */
  orderRuns: Map<string, OrderRunEntry>;
  /** Live-mode `symphony_ask` calls awaiting an operator answer, keyed by ask id. */
  pendingAsks: Map<string, PendingAsk>;
  totals: Totals;
  rateLimits: unknown | null;
  pollCheckInProgress: boolean;
  tickTimer: NodeJS.Timeout | null;
}

export function createState(): OrchestratorState {
  return {
    running: new Map(),
    claimed: new Set(),
    completed: new Set(),
    continuations: new Map(),
    blocked: new Map(),
    retryAttempts: new Map(),
    resumeSessions: new Map(),
    planRuns: new Map(),
    orderRuns: new Map(),
    pendingAsks: new Map(),
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, secondsRunning: 0 },
    rateLimits: null,
    pollCheckInProgress: false,
    tickTimer: null,
  };
}

export function newRunningEntry(
  issue: NormalizedIssue,
  attempt: number,
  now: number,
): RunningEntry {
  return {
    issue,
    identifier: issue.identifier,
    abort: new AbortController(),
    workspacePath: null,
    sessionId: null,
    tmuxSession: null,
    pid: null,
    lastEvent: null,
    lastEventAt: null,
    startedAt: now,
    turnCount: 0,
    retryAttempt: attempt,
    tokens: emptyTokenState(),
    eventBuffer: [],
  };
}
