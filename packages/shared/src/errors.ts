/** Recommended error categories for agent/turn failures (SPEC §10.6). */
export type ErrorCategory =
  | 'agent_not_found'
  | 'invalid_workspace_cwd'
  | 'response_timeout'
  | 'turn_timeout'
  | 'process_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required';

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
