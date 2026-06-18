import { execa } from 'execa';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeIssue } from '../test-support.js';
import { WorkspaceManager } from './manager.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('WorkspaceManager (real git worktrees)', () => {
  let tmp: string;
  let repo: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-wm-'));
    repo = path.join(tmp, 'source-repo');
    root = path.join(tmp, 'workspaces');
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) => execa('git', args, { cwd: repo });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'README.md'), '# source\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
  }, 30_000);

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('clones once, creates a per-issue worktree + branch, reuses, and cleans up', async () => {
    const wm = new WorkspaceManager(
      { root, repo, branch_prefix: 'symphony/', mode: 'worktree', merge_on_accept: true },
      { timeout_ms: 60_000, after_create: 'echo created > .symphony-marker' },
    );
    await wm.init();

    const issue = makeIssue({ id: '1', identifier: 'MT-1' });
    const ws = await wm.createForIssue(issue);
    expect(ws.created).toBe(true);
    expect(ws.branch).toBe('symphony/MT-1');
    expect(await pathExists(ws.path)).toBe(true);
    // after_create hook ran in the worktree
    expect(await pathExists(path.join(ws.path, '.symphony-marker'))).toBe(true);
    // branch exists in the shared clone
    const branches = await execa('git', [
      '-C',
      path.join(root, '.repo'),
      'branch',
      '--list',
      'symphony/MT-1',
    ]);
    expect(branches.stdout).toContain('symphony/MT-1');

    // reuse → not created again
    const again = await wm.createForIssue(issue);
    expect(again.created).toBe(false);

    await wm.cleanup(issue);
    expect(await pathExists(ws.path)).toBe(false);
  }, 30_000);

  it('merges an accepted issue branch into base so the next worktree builds on top', async () => {
    const wm = new WorkspaceManager(
      { root, repo, branch_prefix: 'symphony/', mode: 'worktree', merge_on_accept: true },
      { timeout_ms: 60_000 },
    );
    await wm.init();

    // Issue 1: commit a file on its branch, then accept (merge into main).
    const i1 = makeIssue({ id: '1', identifier: 'MT-1' });
    const ws1 = await wm.createForIssue(i1);
    await writeFile(path.join(ws1.path, 'one.txt'), 'one\n');
    const git1 = (args: string[]) => execa('git', args, { cwd: ws1.path });
    await git1(['add', '.']);
    await git1(['commit', '-m', 'add one']);
    const res = await wm.integrate(i1);
    expect(res.merged).toBe(true);
    await wm.cleanup(i1);

    // Issue 2's worktree branches off the (now-merged) base → it contains issue 1's work.
    const ws2 = await wm.createForIssue(makeIssue({ id: '2', identifier: 'MT-2' }));
    expect(await pathExists(path.join(ws2.path, 'one.txt'))).toBe(true);
  }, 30_000);

  it('does not merge when merge_on_accept is off', async () => {
    const wm = new WorkspaceManager(
      { root, repo, branch_prefix: 'symphony/', mode: 'worktree', merge_on_accept: false },
      { timeout_ms: 60_000 },
    );
    await wm.init();
    const i1 = makeIssue({ id: '1', identifier: 'MT-1' });
    const ws1 = await wm.createForIssue(i1);
    await writeFile(path.join(ws1.path, 'one.txt'), 'one\n');
    const git1 = (args: string[]) => execa('git', args, { cwd: ws1.path });
    await git1(['add', '.']);
    await git1(['commit', '-m', 'add one']);
    expect(await wm.integrate(i1)).toEqual({ merged: false });
    await wm.cleanup(i1);
    const ws2 = await wm.createForIssue(makeIssue({ id: '2', identifier: 'MT-2' }));
    expect(await pathExists(path.join(ws2.path, 'one.txt'))).toBe(false);
  }, 30_000);
});
