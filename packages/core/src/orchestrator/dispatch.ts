import type { NormalizedIssue } from '@symphony/shared';

/** Sort candidates for dispatch: priority asc (nulls last), then oldest createdAt, then identifier. */
export function sortForDispatch(issues: NormalizedIssue[]): NormalizedIssue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ca = a.createdAt ?? '';
    const cb = b.createdAt ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}

const CONTINUATION_DELAY_MS = 1_000;
const FAILURE_BASE_MS = 10_000;
const MAX_POWER = 10;

/** Retry delay (SPEC §16): fixed 1s for continuation, capped exponential for failures. */
export function retryDelay(
  attempt: number,
  delayType: 'continuation' | 'failure',
  maxBackoffMs: number,
): number {
  if (delayType === 'continuation') return CONTINUATION_DELAY_MS;
  const power = Math.min(Math.max(attempt - 1, 0), MAX_POWER);
  return Math.min(FAILURE_BASE_MS * 2 ** power, maxBackoffMs);
}

/** A Todo issue is blocked when any blocker is in a non-terminal state (SPEC §8). */
export function todoBlockedByNonTerminal(
  issue: NormalizedIssue,
  terminalStates: Set<string>,
): boolean {
  return issue.blockedBy.some((b) => !terminalStates.has(b.state));
}

export function hasRequiredFields(issue: NormalizedIssue): boolean {
  return Boolean(issue.id && issue.identifier && issue.title && issue.state);
}
