import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryTracker, scaffoldProject } from '@symphony/tracker';
import { buildDashboardSource } from './dashboard-source.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { PromptBuilder } from './prompt/builder.js';
import { buildTracker } from './runtime.js';
import { FakeWorkspaceManager, MockBackend, testConfig } from './test-support.js';

function build() {
  const tracker = new MemoryTracker({
    issues: [],
    activeStates: ['Todo'],
    terminalStates: ['Done'],
  });
  const orchestrator = new Orchestrator({
    tracker,
    backend: new MockBackend([{ status: 'success' }]),
    workspaceManager: new FakeWorkspaceManager(),
    config: testConfig({
      agent: { max_concurrent_agents: 7, max_turns: 12 },
      tracker: { kind: 'memory', active_states: ['Todo'], terminal_states: ['Done'] },
    }),
    promptBuilder: new PromptBuilder('do'),
  });
  // No store wired → project/settings writes are unavailable.
  return buildDashboardSource(orchestrator);
}

describe('buildDashboardSource (project/settings surface)', () => {
  it('reports projects + settings unavailable for a memory tracker without a store', () => {
    const caps = build().capabilities();
    expect(caps.projects).toBe(false);
    expect(caps.settings).toBe(false);
  });

  it('getSettings reflects the live config', () => {
    const s = build().getSettings();
    expect(s.agent.max_concurrent_agents).toBe(7);
    expect(s.agent.max_turns).toBe(12);
    expect(s.workspace.branch_prefix).toBe('symphony/');
  });

  it('write ops reject when no store is wired', async () => {
    const source = build();
    await expect(source.updateSettings({ agent: { max_turns: 3 } })).rejects.toThrow();
    await expect(source.switchProject('whatever')).rejects.toThrow();
    await expect(
      source.createProject({ name: 'X', identifier: 'X', repo: '/tmp/x' }),
    ).rejects.toThrow();
  });

  it('listProjects returns an empty registry for a non-file tracker', async () => {
    const res = await build().listProjects();
    expect(res.projects).toEqual([]);
    expect(res.active_project_id).toBeNull();
  });

  it('getIssueDetail surfaces worktree_path only when the worktree dir exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-wt-'));
    try {
      const tracker = new MemoryTracker({ activeStates: ['Todo'], terminalStates: ['Done'] });
      const issue = await tracker.createIssue({ title: 'x' });
      const orchestrator = new Orchestrator({
        tracker,
        backend: new MockBackend([{ status: 'success' }]),
        workspaceManager: new FakeWorkspaceManager(),
        config: testConfig({
          workspace: { root },
          tracker: { kind: 'memory', active_states: ['Todo'], terminal_states: ['Done'] },
        }),
        promptBuilder: new PromptBuilder('do'),
      });
      const source = buildDashboardSource(orchestrator);
      // No worktree on disk yet → null (button stays hidden for never-run tickets).
      expect((await source.getIssueDetail(issue.id))?.worktree_path).toBeNull();
      // Once the worktree dir exists, the absolute path is surfaced.
      const wt = path.join(root, issue.identifier);
      await mkdir(wt);
      expect((await source.getIssueDetail(issue.id))?.worktree_path).toBe(wt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('buildDashboardSource (file tracker projects)', () => {
  let root: string;

  function buildFile() {
    const config = testConfig({
      tracker: { kind: 'file', data_root: root, project_id: 'default' },
    });
    const orchestrator = new Orchestrator({
      tracker: buildTracker(config),
      backend: new MockBackend([{ status: 'success' }]),
      workspaceManager: new FakeWorkspaceManager(),
      config,
      promptBuilder: new PromptBuilder('do'),
    });
    return buildDashboardSource(orchestrator); // no store wired
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ds-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('capabilities.projects is false without a store even for the file tracker', () => {
    expect(buildFile().capabilities().projects).toBe(false);
  });

  it('listProjects surfaces the active default + on-disk project dirs', async () => {
    await scaffoldProject({
      dataRoot: root,
      projectKey: 'beta',
      seed: { identifier: 'BET', states: [] },
    });
    const res = await buildFile().listProjects();
    expect(res.active_project_id).toBe('default');
    const ids = res.projects.map((p) => p.project_id).sort();
    expect(ids).toContain('beta');
    expect(ids).toContain('default');
    expect(res.projects.find((p) => p.project_id === 'default')?.active).toBe(true);
  });
});
