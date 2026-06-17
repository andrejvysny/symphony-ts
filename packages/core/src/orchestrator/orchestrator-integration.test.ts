import { execa } from 'execa';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  CodingAgentBackend,
  RunOptions,
  RunResult,
} from '@symphony/agent-backends';
import { MemoryTracker } from '@symphony/tracker';
import { parseConfig, resolveConfig } from '../config/resolve.js';
import { PromptBuilder } from '../prompt/builder.js';
import { makeIssue } from '../test-support.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { Orchestrator } from './orchestrator.js';

/**
 * Full commit-only loop with the REAL WorkspaceManager + real git worktrees (no real
 * agent). Exercises the exact Phase-2 path: orchestrator dispatch → worktree off a local
 * shared clone → a scripted "agent" that commits in the worktree and parks the ticket via
 * the tracker (as Claude would via mcp__symphony__linear_graphql) → worker observes the
 * non-active state and releases, PRESERVING the workspace. This is the one test that wires
 * the orchestrator to real git; the agent itself stays mocked.
 */

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Symphony Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Symphony Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A backend that commits real work in the worktree, then parks the ticket. */
function committingBackend(
  tracker: MemoryTracker,
  issueId: string,
  parkState: string,
): CodingAgentBackend {
  return {
    kind: 'committing',
    async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
      const at = new Date(0).toISOString();
      yield { type: 'session_started', sessionId: 's', at };
      await writeFile(path.join(opts.cwd, 'CHANGE.md'), '# implemented by the agent\n');
      await execa('git', ['add', '.'], { cwd: opts.cwd });
      await execa('git', ['commit', '-m', 'agent: implement'], {
        cwd: opts.cwd,
        env: GIT_IDENTITY,
      });
      // As the agent would via mcp__symphony__linear_graphql: move the ticket out of an
      // active state so the worker stops (commit-only mode parks for a human).
      tracker.setState(issueId, parkState);
      const result: RunResult = {
        status: 'success',
        sessionId: 's',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      yield { type: 'turn_completed', at };
      yield { type: 'result', result, at };
      return result;
    },
  };
}

describe('Orchestrator + real git worktree (commit-only loop)', () => {
  let tmp: string;
  let repo: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-int-'));
    repo = path.join(tmp, 'source-repo');
    root = path.join(tmp, 'workspaces');
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) => execa('git', args, { cwd: repo, env: GIT_IDENTITY });
    await git(['init', '-b', 'main']);
    await writeFile(path.join(repo, 'README.md'), '# source\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
  }, 30_000);

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('dispatches, commits in the worktree, parks the ticket, and preserves the workspace', async () => {
    const config = resolveConfig(
      parseConfig({
        tracker: {
          kind: 'memory',
          active_states: ['Todo', 'In Progress'],
          terminal_states: ['Done', 'Canceled'],
        },
        workspace: { repo, root, branch_prefix: 'symphony/' },
        agent: { max_turns: 1, max_continuations: 0, stall_timeout_ms: 0 },
        polling: { interval_ms: 60_000 },
      }),
      tmp,
    );
    const tracker = new MemoryTracker({
      issues: [makeIssue({ id: 'mt1', identifier: 'MT-1', state: 'Todo' })],
      activeStates: config.tracker.active_states,
      terminalStates: config.tracker.terminal_states,
    });
    const wm = new WorkspaceManager(config.workspace, config.hooks);
    await wm.init();
    const orchestrator = new Orchestrator({
      tracker,
      backend: committingBackend(tracker, 'mt1', 'Human Review'),
      workspaceManager: wm,
      config,
      promptBuilder: new PromptBuilder('work on {{ issue.identifier }}'),
    });

    await orchestrator.runOnce();
    await waitFor(() => orchestrator.snapshot().counts.running === 0);

    const worktree = path.join(root, 'MT-1');
    // Workspace preserved (commit-only invariant: not cleaned on a non-terminal stop).
    expect(await pathExists(worktree)).toBe(true);
    expect(await pathExists(path.join(worktree, 'CHANGE.md'))).toBe(true);

    const branch = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
    expect(branch.stdout.trim()).toBe('symphony/MT-1');
    const subject = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: worktree });
    expect(subject.stdout.trim()).toBe('agent: implement');

    // Ticket was parked; orchestrator released it without retry/cleanup/continuation.
    expect(tracker.get('mt1')?.state).toBe('Human Review');
    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.retrying).toBe(0);
    expect(snap.counts.blocked).toBe(0);
    expect(snap.counts.completed).toBe(0); // non-active release is not a completion

    await orchestrator.stop();
  }, 30_000);
});
