/**
 * Error categories for agent/turn failures. The first block mirrors SPEC §10.6; the second
 * block extends it (symphony-ts diverges from SPEC by choice) so the recovery layer can tell
 * permanent failures (→ blocked) from transient ones (→ bounded retry). See
 * `@symphony/agent-backends` `classify()` for the signal/exit/text → category mapping and the
 * derived `retryable` bit.
 */
export type ErrorCategory =
  // SPEC §10.6
  | 'agent_not_found'
  | 'invalid_workspace_cwd'
  | 'response_timeout'
  | 'turn_timeout'
  | 'process_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required'
  // symphony-ts extensions (recovery taxonomy)
  | 'auth_required'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'prompt_too_large'
  | 'idle_timeout';

/** Raised by a worker turn loop when the agent needs operator input (→ blocked). */
export class BlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`agent blocked: ${reason}`);
    this.name = 'BlockedError';
    this.reason = reason;
  }
}

/** Raised when a workspace path fails a safety invariant (SPEC §9.5). */
export class WorkspaceSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSafetyError';
  }
}

/** Configuration / preflight validation failure (SPEC §6.3). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
