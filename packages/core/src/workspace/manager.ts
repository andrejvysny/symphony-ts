import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { NormalizedIssue } from '@symphony/shared';
import { ConfigError } from '@symphony/shared';
import type { HooksConfig, WorkspaceConfig } from '../config/schema.js';
import { runHook, type HookOutcome } from './hooks.js';
import { addWorktree, ensureSharedClone, removeWorktree, type SharedRepo } from './git-worktree.js';
import { assertUnderRoot, sanitizeIdentifier } from './path-safety.js';

export interface Workspace {
  path: string;
  branch: string;
  created: boolean;
}

/** The subset of workspace operations the orchestrator/worker depend on (injectable in tests). */
export interface IWorkspaceManager {
  createForIssue(issue: NormalizedIssue): Promise<Workspace>;
  runBeforeRun(issue: NormalizedIssue, ws: Workspace): Promise<HookOutcome>;
  runAfterRun(issue: NormalizedIssue, ws: Workspace): Promise<HookOutcome>;
  cleanup(issue: NormalizedIssue): Promise<void>;
}

export class WorkspaceManager implements IWorkspaceManager {
  private shared: SharedRepo | undefined;

  constructor(
    private readonly workspace: WorkspaceConfig & { root: string },
    private readonly hooks: HooksConfig,
  ) {}

  /** Clone the shared repo once. Must be called before createForIssue. */
  async init(): Promise<void> {
    if (!this.workspace.repo) throw new ConfigError('workspace.repo is required');
    await mkdir(this.workspace.root, { recursive: true });
    this.shared = await ensureSharedClone(this.workspace.repo, this.workspace.root);
  }

  private hookEnv(issue: NormalizedIssue, wsPath: string, branch: string): Record<string, string> {
    return {
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_WORKSPACE: wsPath,
      SYMPHONY_BRANCH: branch,
      ...(this.workspace.repo ? { SYMPHONY_REPO: this.workspace.repo } : {}),
    };
  }

  branchFor(issue: NormalizedIssue): string {
    return `${this.workspace.branch_prefix}${issue.identifier}`;
  }

  /** Create (or reuse) the per-issue worktree; runs after_create on new ones. */
  async createForIssue(issue: NormalizedIssue): Promise<Workspace> {
    if (!this.shared)
      throw new ConfigError('WorkspaceManager.init() must run before createForIssue');
    const key = sanitizeIdentifier(issue.identifier);
    const candidate = path.join(this.workspace.root, key);
    const wsPath = assertUnderRoot(candidate, this.workspace.root);
    const branch = this.branchFor(issue);

    const { created } = await addWorktree(this.shared, wsPath, branch, this.shared.defaultBranch);

    if (created) {
      const outcome = await runHook(this.hooks, 'after_create', {
        cwd: wsPath,
        env: this.hookEnv(issue, wsPath, branch),
      });
      if (!outcome.ok) {
        throw new ConfigError(`after_create hook failed: ${outcome.error ?? 'unknown'}`);
      }
    }
    return { path: wsPath, branch, created };
  }

  async runBeforeRun(issue: NormalizedIssue, ws: Workspace): Promise<HookOutcome> {
    return runHook(this.hooks, 'before_run', {
      cwd: ws.path,
      env: this.hookEnv(issue, ws.path, ws.branch),
    });
  }

  async runAfterRun(issue: NormalizedIssue, ws: Workspace): Promise<HookOutcome> {
    return runHook(this.hooks, 'after_run', {
      cwd: ws.path,
      env: this.hookEnv(issue, ws.path, ws.branch),
    });
  }

  /** Remove the worktree for a terminal issue (branch preserved). */
  async cleanup(issue: NormalizedIssue): Promise<void> {
    if (!this.shared) return;
    const key = sanitizeIdentifier(issue.identifier);
    const wsPath = path.join(this.workspace.root, key);
    const branch = this.branchFor(issue);
    await runHook(this.hooks, 'before_remove', {
      cwd: wsPath,
      env: this.hookEnv(issue, wsPath, branch),
    });
    await removeWorktree(this.shared, wsPath);
  }
}
