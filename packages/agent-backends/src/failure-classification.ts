import type { ErrorCategory } from '@symphony/shared';

/**
 * Single source of truth for mapping a failed agent run onto an {@link ErrorCategory} plus a
 * derived `retryable` bit. Adapted from nexu-io/open-design's `run-failure-classification.ts`:
 * a cascade of structured category > OS signal/exit code > error-text heuristics, ordered so a
 * crash signal can never be laundered into a (retryable) timeout.
 *
 * `retryable` is what the orchestrator gates re-dispatch on: **permanent** causes (missing CLI,
 * bad cwd, auth, oversized prompt, hard usage quota, process crash) → not retryable → the issue
 * goes to `blocked` for operator attention; **transient** causes (timeouts, rate limits, upstream
 * blips, generic non-zero exit) → retryable under a bounded attempt cap.
 */
export interface ClassifyInput {
  /** Process exit code, if the run ended via process close. */
  exitCode?: number | null;
  /** OS signal that killed the process, if any (e.g. 'SIGKILL', 'SIGSEGV'). */
  signal?: NodeJS.Signals | string | null;
  /** Error text / stderr tail / native error message to scan. */
  text?: string;
  /** A category the caller already determined (e.g. from a parsed event); refined further here. */
  category?: ErrorCategory;
}

export interface Classification {
  category: ErrorCategory;
  retryable: boolean;
}

/** Categories that always mean "stop and ask an operator" — never auto-retried. */
const PERMANENT: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'agent_not_found',
  'invalid_workspace_cwd',
  'auth_required',
  'prompt_too_large',
]);

/** Signals that mean the process crashed abnormally — non-retryable (re-running reproduces it). */
const CRASH_SIGNALS: ReadonlySet<string> = new Set([
  'SIGSEGV',
  'SIGABRT',
  'SIGILL',
  'SIGTRAP',
  'SIGBUS',
]);

const RE_AGENT_MISSING = /\b(enoent|command not found|not on path|not installed|spawn e[a-z]+)\b/i;
// No surrounding \b: an API-key var name like ANTHROPIC_API_KEY has no word boundary before
// "API" (preceded by '_'), which a \b-anchored alternation would miss.
const RE_AUTH =
  /(unauthorized|not logged in|login required|auth(?:entication)? (?:required|expired|failed)|refresh token|access token|api[_ -]?key.*(?:missing|invalid|not set)|missing.*api[_ -]?key|credentials? (?:are )?(?:missing|invalid))/i;
const RE_PROMPT_TOO_LARGE =
  /\b(context window|prompt too large|maximum context(?: length)?|too many tokens|input.*too large|exceeds.*context|reduce the length of)\b/i;
const RE_HARD_QUOTA =
  /\b(usage limit|session limit|limit reached|quota|billing.*limit|insufficient (?:quota|credit|funds|balance)|exceeded your current quota)\b/i;
const RE_RATE_LIMIT = /\b(rate[ _-]?limit|429|too many requests|overloaded_error)\b/i;
const RE_UPSTREAM =
  /\b(5\d\d|bad gateway|gateway timeout|service unavailable|internal server error|overloaded|stream disconnected|connection reset|econnreset|etimedout|socket hang ?up|broken pipe|tls|network error|upstream)\b/i;
const RE_TIMEOUT =
  /\b(timed? ?out|timeout|inactivity|stalled|hung|no new output|without.*output)\b/i;
const RE_INACTIVITY = /\b(inactivity|stalled|hung|no new output|without.*output|idle)\b/i;
const RE_EMPTY_OUTPUT =
  /\b(empty (?:response|output)|no (?:visible )?output|produced no (?:result|output))\b/i;

function permanent(category: ErrorCategory): Classification {
  return { category, retryable: false };
}
function transient(category: ErrorCategory): Classification {
  return { category, retryable: true };
}

/** Classify a failed run. Returns the best {@link ErrorCategory} + whether it is worth retrying. */
export function classify(input: ClassifyInput): Classification {
  const { exitCode, signal, category } = input;
  const text = input.text ?? '';

  // 1. Authoritative structural categories the caller already nailed down.
  if (category === 'agent_not_found' || category === 'invalid_workspace_cwd') {
    return permanent(category);
  }

  // 2. OS signal: crashes and forced kills are non-retryable; never reinterpreted as timeouts.
  if (typeof signal === 'string' && signal) {
    if (signal === 'SIGKILL' || CRASH_SIGNALS.has(signal)) return permanent('process_exit');
    // Other signals (e.g. SIGTERM) fall through to text/exit so an inactivity-driven kill can
    // still be recognized as a (retryable) timeout below.
  }

  // 3. Text heuristics — richest meaning, ordered most-specific first.
  if (RE_AGENT_MISSING.test(text)) return permanent('agent_not_found');
  if (RE_AUTH.test(text)) return permanent('auth_required');
  if (RE_PROMPT_TOO_LARGE.test(text)) return permanent('prompt_too_large');
  if (RE_RATE_LIMIT.test(text) || RE_HARD_QUOTA.test(text)) {
    // A hard quota / balance exhaustion won't clear on its own — don't burn retries on it.
    return { category: 'rate_limited', retryable: !RE_HARD_QUOTA.test(text) };
  }
  if (RE_UPSTREAM.test(text)) return transient('upstream_unavailable');
  if (RE_TIMEOUT.test(text)) {
    return transient(RE_INACTIVITY.test(text) ? 'idle_timeout' : 'turn_timeout');
  }
  if (RE_EMPTY_OUTPUT.test(text)) return transient('response_error');

  // 4. A category the caller passed that we didn't refine — honor it, derive retryability.
  if (category) return { category, retryable: !PERMANENT.has(category) };

  // 5. Exit-code fallback. Generic non-zero exit is transient (bounded by the retry cap).
  if (typeof exitCode === 'number' && exitCode !== 0) return transient('process_exit');

  return transient('response_error');
}

/** Whether a category is permanent (→ blocked) regardless of any text context. */
export function isPermanentCategory(category: ErrorCategory): boolean {
  return PERMANENT.has(category);
}
