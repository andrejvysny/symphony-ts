import type { NormalizedIssue } from '@symphony/shared';
import { emptyTokenState, type TokenState } from './token-accounting.js';

export interface RunningEntry {
  issue: NormalizedIssue;
  identifier: string;
  abort: AbortController;
  workspacePath: string | null;
  sessionId: string | null;
  lastEvent: string | null;
  lastEventAt: number | null;
  startedAt: number;
  turnCount: number;
  retryAttempt: number;
  tokens: TokenState;
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
    lastEvent: null,
    lastEventAt: null,
    startedAt: now,
    turnCount: 0,
    retryAttempt: attempt,
    tokens: emptyTokenState(),
  };
}
