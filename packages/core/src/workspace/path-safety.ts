import { realpathSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceSafetyError } from '@symphony/shared';

/** Sanitize an issue identifier to a workspace key (SPEC §9.5 invariant 3). */
export function sanitizeIdentifier(identifier: string): string {
  const key = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  if (key.length === 0 || key === '.' || key === '..') {
    throw new WorkspaceSafetyError(`identifier "${identifier}" sanitizes to an unsafe key`);
  }
  return key;
}

/** Canonicalize a path, resolving symlinks for any existing prefix. */
export function canonicalize(p: string): string {
  const abs = path.resolve(p);
  // Resolve the longest existing ancestor via realpath, then re-append the rest.
  let existing = abs;
  const tail: string[] = [];
  while (existing !== path.dirname(existing)) {
    try {
      return path.join(realpathSync(existing), ...tail.reverse());
    } catch {
      tail.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  return abs;
}

/**
 * Require `candidate` to live under `root` after canonicalization
 * (SPEC §9.5 invariant 2). Returns the canonical candidate path.
 */
export function assertUnderRoot(candidate: string, root: string): string {
  const canonRoot = canonicalize(root);
  const canonCandidate = canonicalize(candidate);
  const rel = path.relative(canonRoot, canonCandidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceSafetyError(`workspace path ${canonCandidate} escapes root ${canonRoot}`);
  }
  return canonCandidate;
}

/** Assert an agent's cwd equals its workspace path (SPEC §9.5 invariant 1). */
export function assertCwdIsWorkspace(cwd: string, workspacePath: string): void {
  if (canonicalize(cwd) !== canonicalize(workspacePath)) {
    throw new WorkspaceSafetyError(`agent cwd ${cwd} does not match workspace ${workspacePath}`);
  }
}
