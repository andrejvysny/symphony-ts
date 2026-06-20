import type { NormalizedIssue } from '@symphony/shared';

/**
 * Sort candidates for dispatch: rank asc (unranked last), then priority asc (nulls last), then oldest
 * createdAt, then identifier. `rank` is the Sequence feature's resolved order — a ranked (sequenced)
 * batch therefore dispatches ahead of unranked tickets, in order. With every `rank` absent this is
 * byte-for-byte the legacy priority/createdAt/identifier order.
 */
export function sortForDispatch(issues: NormalizedIssue[]): NormalizedIssue[] {
  return [...issues].sort((a, b) => {
    const ra = a.rank ?? Number.POSITIVE_INFINITY;
    const rb = b.rank ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
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

/**
 * Retry delay: fixed 1s for continuation, jittered capped-exponential for failures.
 *
 * Failures use **equal jitter** (`base/2 + rand(0, base/2)`): half the capped exponential
 * delay is fixed, half is random. This decorrelates concurrent failure retries — a single
 * tracker/network blip that fails many running issues at once no longer reschedules them all
 * onto the same instant (thundering herd) — while keeping the worst case `< base`. `rng` is
 * injectable so tests stay deterministic. Continuation re-checks are not jittered.
 */
export function retryDelay(
  attempt: number,
  delayType: 'continuation' | 'failure',
  maxBackoffMs: number,
  rng: () => number = Math.random,
): number {
  if (delayType === 'continuation') return CONTINUATION_DELAY_MS;
  const power = Math.min(Math.max(attempt - 1, 0), MAX_POWER);
  const base = Math.min(FAILURE_BASE_MS * 2 ** power, maxBackoffMs);
  return Math.floor(base / 2 + rng() * (base / 2));
}

/**
 * An issue is blocked when any of its blockers is in a non-terminal state (SPEC §8). A blocker in
 * ANY terminal state (Done/Closed but also Cancelled/Duplicate) counts as satisfied — a cancelled
 * blocker must not deadlock its dependent. Applies in every active state (the Sequence feature
 * populates `blockedBy`; legacy tickets have `[]` and are never gated).
 */
export function blockedByNonTerminal(issue: NormalizedIssue, terminalStates: Set<string>): boolean {
  return issue.blockedBy.some((b) => !terminalStates.has(b.state));
}

export function hasRequiredFields(issue: NormalizedIssue): boolean {
  return Boolean(issue.id && issue.identifier && issue.title && issue.state);
}
