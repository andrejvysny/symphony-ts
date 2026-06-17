import { describe, expect, it } from 'vitest';
import { MemoryTracker } from '@symphony/tracker';
import { buildDashboardSource } from './dashboard-source.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { PromptBuilder } from './prompt/builder.js';
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
  it('reports projects + settings unavailable without a Plane tracker / store', () => {
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

  it('listProjects returns an empty registry for a non-Plane tracker', async () => {
    const res = await build().listProjects();
    expect(res.projects).toEqual([]);
    expect(res.active_project_id).toBeNull();
  });
});
