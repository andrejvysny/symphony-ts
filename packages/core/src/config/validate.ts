import type { SymphonyConfig } from './resolve.js';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

const SUPPORTED_TRACKERS = new Set(['linear', 'memory']);

/**
 * Dispatch preflight validation (SPEC §6.3). At startup a failure is fatal;
 * per-tick a failure skips dispatch but keeps reconciliation running.
 */
export function dispatchPreflight(config: SymphonyConfig): PreflightResult {
  const errors: string[] = [];
  const { tracker, workspace, agent } = config;

  if (!tracker.kind) errors.push('tracker.kind is required');
  else if (!SUPPORTED_TRACKERS.has(tracker.kind))
    errors.push(`tracker.kind "${tracker.kind}" is not supported`);

  if (tracker.kind === 'linear') {
    if (!tracker.api_key)
      errors.push('tracker.api_key is required for linear (set LINEAR_API_KEY)');
    if (!tracker.project_slug) errors.push('tracker.project_slug is required for linear');
  }

  if (!workspace.repo) errors.push('workspace.repo is required (local path or git URL)');

  if (agent.backend !== 'claude-sdk' && !agent.command && agent.backend.endsWith('-cli')) {
    // CLI backends need a resolvable binary; default binary is the backend prefix.
    // Resolved PATH check happens lazily in the backend; here we only sanity-check config.
  }

  return { ok: errors.length === 0, errors };
}
