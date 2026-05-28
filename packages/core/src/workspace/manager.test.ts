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
      { root, repo, branch_prefix: 'symphony/' },
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
});
