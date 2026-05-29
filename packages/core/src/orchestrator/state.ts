import type { AgentEvent } from '@symphony/agent-backends';
import type { NormalizedIssue } from '@symphony/shared';
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
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
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
