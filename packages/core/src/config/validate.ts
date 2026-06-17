import type { SymphonyConfig } from './resolve.js';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

const SUPPORTED_TRACKERS = new Set(['plane', 'memory']);

/**
 * Dispatch preflight validation (SPEC §6.3). At startup a failure is fatal;
 * per-tick a failure skips dispatch but keeps reconciliation running. When `detection` is
 * provided (the one-time agent-binary probe) a missing binary fails preflight, so a misconfigured
 * agent surfaces as a clear skip-with-reason instead of every issue failing with an opaque exit-127.
 */
export function dispatchPreflight(
  config: SymphonyConfig,
  detection?: { found: boolean; binary: string },
): PreflightResult {
  const errors: string[] = [];
  const { tracker, workspace } = config;

  if (!tracker.kind) errors.push('tracker.kind is required');
  else if (!SUPPORTED_TRACKERS.has(tracker.kind))
    errors.push(`tracker.kind "${tracker.kind}" is not supported`);

  if (tracker.kind === 'plane') {
    if (!tracker.api_key) errors.push('tracker.api_key is required for plane (set PLANE_API_KEY)');
    if (!tracker.endpoint)
      errors.push('tracker.endpoint is required for plane (Plane instance URL)');
    if (!tracker.workspace_slug) errors.push('tracker.workspace_slug is required for plane');
    if (!tracker.project_id) errors.push('tracker.project_id is required for plane');
  }

  if (!workspace.repo) errors.push('workspace.repo is required (local path or git URL)');

  if (detection && !detection.found) {
    errors.push(`agent binary "${detection.binary}" not found on PATH`);
  }

  return { ok: errors.length === 0, errors };
}
