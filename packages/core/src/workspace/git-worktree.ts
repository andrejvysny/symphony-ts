import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

const SHARED_DIR_NAME = '.repo';

/** Per-shared-repo mutex: serialize worktree add/remove to avoid git index races. */
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface SharedRepo {
  dir: string;
  git: SimpleGit;
  defaultBranch: string;
}

/** Clone `repo` into <root>/.repo once; fetch on subsequent boots. */
export async function ensureSharedClone(repo: string, root: string): Promise<SharedRepo> {
  await mkdir(root, { recursive: true });
  const dir = path.join(root, SHARED_DIR_NAME);
  return withLock(dir, async () => {
    if (!(await exists(path.join(dir, '.git')))) {
      await simpleGit().clone(repo, dir);
    } else {
      try {
        await simpleGit(dir).fetch(['--all', '--prune']);
      } catch {
        /* offline / local repo without reachable remote — proceed with what we have */
      }
    }
    const git = simpleGit(dir);
    const defaultBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    return { dir, git, defaultBranch };
  });
}

async function branchExists(git: SimpleGit, branch: string): Promise<boolean> {
  const out = await git.raw(['branch', '--list', branch]);
  return out.trim().length > 0;
}

/**
 * Create (or reuse) a worktree at `worktreePath` on branch `branch` off
 * `baseRef`. Returns whether the worktree was newly created.
 */
export async function addWorktree(
  shared: SharedRepo,
  worktreePath: string,
  branch: string,
  baseRef?: string,
): Promise<{ created: boolean }> {
  return withLock(shared.dir, async () => {
    if (await exists(worktreePath)) return { created: false };
    const base = baseRef ?? shared.defaultBranch;
    if (await branchExists(shared.git, branch)) {
      await shared.git.raw(['worktree', 'add', worktreePath, branch]);
    } else {
      await shared.git.raw(['worktree', 'add', worktreePath, '-b', branch, base]);
    }
    return { created: true };
  });
}

/** Remove a worktree (branch is intentionally preserved). */
export async function removeWorktree(shared: SharedRepo, worktreePath: string): Promise<void> {
  return withLock(shared.dir, async () => {
    if (!(await exists(worktreePath))) return;
    await shared.git.raw(['worktree', 'remove', '--force', worktreePath]);
  });
}
