import { execa } from 'execa';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeIssue } from '../test-support.js';
import type { WorkspaceConfig } from '../config/schema.js';
import { SingleDirWorkspaceManager } from './single-dir-manager.js';

const hooks = { timeout_ms: 60_000 };
const wsConfig = (repo: string): WorkspaceConfig & { root: string } => ({
  mode: 'single_dir',
  repo,
  root: path.join(repo, '..', 'unused-root'),
  branch_prefix: 'symphony/',
  merge_on_accept: true,
});

describe('SingleDirWorkspaceManager (real git)', () => {
  let tmp: string;
  let repo: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-sd-'));
    repo = path.join(tmp, 'project');
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) => execa('git', args, { cwd: repo });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'README.md'), '# project\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
  }, 30_000);

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('runs in the repo on its current branch; cleanup + integrate are no-ops', async () => {
    const wm = new SingleDirWorkspaceManager(wsConfig(repo), hooks);
    await wm.init();
    const ws = await wm.createForIssue(makeIssue({ id: '1', identifier: 'SD-1' }));
    // init() canonicalizes via `git rev-parse --show-toplevel` (so cwd == real repo toplevel).
    expect(ws.path).toBe(await realpath(repo));
    expect(ws.branch).toBe('main');
    expect(ws.created).toBe(false);

    // integrate is a no-op (the agent commits directly on the live branch).
    expect(await wm.integrate(makeIssue({ id: '1', identifier: 'SD-1' }))).toEqual({
      merged: false,
    });

    // cleanup must NEVER delete the user's project.
    await wm.cleanup(makeIssue({ id: '1', identifier: 'SD-1' }));
    const git = (args: string[]) => execa('git', args, { cwd: repo });
    await expect(git(['rev-parse', '--is-inside-work-tree'])).resolves.toBeTruthy();
  }, 30_000);

  it('reports the live branch (tasks build on the same branch)', async () => {
    const git = (args: string[]) => execa('git', args, { cwd: repo });
    await git(['checkout', '-b', 'feature']);
    const wm = new SingleDirWorkspaceManager(wsConfig(repo), hooks);
    await wm.init();
    const ws = await wm.createForIssue(makeIssue({ id: '2', identifier: 'SD-2' }));
    expect(ws.branch).toBe('feature');
  }, 30_000);

  it('rejects a detached HEAD (no branch to build on)', async () => {
    const git = (args: string[]) => execa('git', args, { cwd: repo });
    const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['checkout', sha]);
    const wm = new SingleDirWorkspaceManager(wsConfig(repo), hooks);
    await wm.init();
    await expect(wm.createForIssue(makeIssue({ id: '3', identifier: 'SD-3' }))).rejects.toThrow(
      /detached HEAD/,
    );
  }, 30_000);

  it('provisions a git repo for a missing/plain folder (import a folder as a project)', async () => {
    const fresh = path.join(tmp, 'imported'); // does not exist yet
    const wm = new SingleDirWorkspaceManager(wsConfig(fresh), hooks);
    await wm.init();
    const ws = await wm.createForIssue(makeIssue({ id: '9', identifier: 'SD-9' }));
    expect(ws.branch).toBe('main');
    const log = await execa('git', ['-C', fresh, 'log', '--oneline'], { reject: false });
    expect(log.stdout).toContain('Initial commit');
  }, 30_000);
});
