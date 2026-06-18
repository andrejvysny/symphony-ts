import { isRemoteRepo, type SymphonyConfig } from './resolve.js';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

const SUPPORTED_TRACKERS = new Set(['file', 'memory']);

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

  if (!workspace.repo) errors.push('workspace.repo is required (local path or git URL)');
  else if (workspace.mode === 'single_dir' && isRemoteRepo(workspace.repo))
    errors.push('single_dir mode requires a local workspace.repo path (not a git URL)');

  if (detection && !detection.found) {
    errors.push(`agent binary "${detection.binary}" not found on PATH`);
  }

  return { ok: errors.length === 0, errors };
}
