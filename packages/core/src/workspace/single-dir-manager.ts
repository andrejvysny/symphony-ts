import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizedIssue } from '@symphony/shared';
import { ConfigError } from '@symphony/shared';
import type { HooksConfig, WorkspaceConfig } from '../config/schema.js';
import { runHook, type HookOutcome } from './hooks.js';
import type { IntegrateResult, IWorkspaceManager, Workspace } from './manager.js';

const execFileAsync = promisify(execFile);

/**
 * Single-directory workspace manager (the default mode): the agent works DIRECTLY in `workspace.repo`
 * on its current branch, ONE task at a time (the orchestrator clamps concurrency to 1 in this mode).
 * No clone, no worktree — each task sees the previous task's committed changes on disk, so multi-task
 * projects accumulate on the checked-out branch (e.g. master). `cleanup()` is a no-op (it must never
 * delete the user's repo) and `integrate()` is a no-op (the agent already committed on the live
 * branch — nothing to merge).
 */
export class SingleDirWorkspaceManager implements IWorkspaceManager {
  private repoDir: string | undefined;

  constructor(
    private readonly workspace: WorkspaceConfig & { root: string },
    private readonly hooks: HooksConfig,
  ) {}

  async init(): Promise<void> {
    const repo = this.workspace.repo;
    if (!repo) throw new ConfigError('workspace.repo is required');
    let top: string;
    try {
      top = (await this.git(['rev-parse', '--show-toplevel'], repo)).trim();
    } catch {
      throw new ConfigError(
        `single_dir workspace.repo is not a git repository (or does not exist): ${repo}`,
      );
    }
    this.repoDir = top;
  }

  async createForIssue(_issue: NormalizedIssue): Promise<Workspace> {
    if (!this.repoDir) {
      throw new ConfigError('SingleDirWorkspaceManager.init() must run before createForIssue');
    }
    const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], this.repoDir)).trim();
    if (branch === 'HEAD') {
      throw new ConfigError(
        `single_dir repo ${this.repoDir} is in detached HEAD; checkout a branch first`,
      );
    }
    return { path: this.repoDir, branch, created: false };
  }

  async runBeforeRun(issue: NormalizedIssue, ws: Workspace): Promise<HookOutcome> {
    return runHook(this.hooks, 'before_run', { cwd: ws.path, env: this.hookEnv(issue, ws) });
  }

  async runAfterRun(issue: NormalizedIssue, ws: Workspace): Promise<HookOutcome> {
    return runHook(this.hooks, 'after_run', { cwd: ws.path, env: this.hookEnv(issue, ws) });
  }

  /** No-op: the agent already committed on the live branch — nothing to merge. */
  async integrate(_issue: NormalizedIssue): Promise<IntegrateResult> {
    return { merged: false };
  }

  /** No-op: never delete the user's project directory. */
  async cleanup(_issue: NormalizedIssue): Promise<void> {
    /* intentionally empty */
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  }

  private hookEnv(issue: NormalizedIssue, ws: Workspace): Record<string, string> {
    return {
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_WORKSPACE: ws.path,
      SYMPHONY_BRANCH: ws.branch,
      ...(this.workspace.repo ? { SYMPHONY_REPO: this.workspace.repo } : {}),
    };
  }
}
