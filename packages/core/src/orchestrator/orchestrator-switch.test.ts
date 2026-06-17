import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryTracker } from '@symphony/tracker';
import { PromptBuilder } from '../prompt/builder.js';
import {
  FakeWorkspaceManager,
  GatedBackend,
  MockBackend,
  makeIssue,
  testConfig,
} from '../test-support.js';
import { Orchestrator } from './orchestrator.js';

async function flush(o: Orchestrator): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 25; i++) await Promise.resolve();
    await o.settle();
  }
}

const TRACKER = { kind: 'memory', active_states: ['Todo'], terminal_states: ['Done'] };

function memTracker(ids: string[]): MemoryTracker {
  return new MemoryTracker({
    issues: ids.map((id) => makeIssue({ id, state: 'Todo' })),
    activeStates: ['Todo'],
    terminalStates: ['Done'],
  });
}

describe('Orchestrator.switchProject', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts running agents, swaps the tracker, and resumes against the new project', async () => {
    const backend = new GatedBackend();
    const tracker1 = memTracker(['a']);
    const tracker2 = memTracker(['b']);
    const wm2 = new FakeWorkspaceManager();
    const orch = new Orchestrator({
      tracker: tracker1,
      backend,
      workspaceManager: new FakeWorkspaceManager(),
      config: testConfig({
        agent: { max_turns: 1, stall_timeout_ms: 0 },
        tracker: { ...TRACKER, project_id: 'p1' },
      }),
      promptBuilder: new PromptBuilder('do'),
      trackerFactory: () => tracker2,
      workspaceManagerFactory: () => wm2,
      mcpConfigFactory: () => undefined,
    });

    await orch.runOnce();
    await flush(orch);
    expect(orch.snapshot().counts.running).toBe(1);
    expect(orch.currentTracker()).toBe(tracker1);

    const next = testConfig({
      agent: { max_turns: 1, stall_timeout_ms: 0 },
      tracker: { ...TRACKER, project_id: 'p2' },
    });
    await orch.switchProject(next);
    await flush(orch);

    expect(orch.currentTracker()).toBe(tracker2);
    expect(orch.currentConfig().tracker.project_id).toBe('p2');
    expect(wm2.initCount).toBe(1);
    expect(orch.snapshot().counts.running).toBe(0);
    expect(orch.snapshot().codex_totals.total_tokens).toBe(0);

    // Resumed polling now dispatches the NEW project's issue.
    await orch.runOnce();
    await flush(orch);
    expect(orch.snapshot().running.map((r) => r.issue_id)).toEqual(['b']);

    backend.releaseAll();
    await orch.stop();
  });

  it('is atomic: a failed new-workspace init leaves the current project intact', async () => {
    const tracker1 = memTracker([]);
    const badWm = new FakeWorkspaceManager();
    badWm.init = async () => {
      throw new Error('bad repo');
    };
    const orch = new Orchestrator({
      tracker: tracker1,
      backend: new MockBackend([{ status: 'success' }]),
      workspaceManager: new FakeWorkspaceManager(),
      config: testConfig({ tracker: { ...TRACKER, project_id: 'p1' } }),
      promptBuilder: new PromptBuilder('do'),
      trackerFactory: () => memTracker([]),
      workspaceManagerFactory: () => badWm,
    });

    const next = testConfig({ tracker: { ...TRACKER, project_id: 'p2' } });
    await expect(orch.switchProject(next)).rejects.toThrow('bad repo');
    expect(orch.currentTracker()).toBe(tracker1);
    expect(orch.currentConfig().tracker.project_id).toBe('p1');
  });

  it('throws when switch factories are not configured', async () => {
    const orch = new Orchestrator({
      tracker: memTracker([]),
      backend: new MockBackend([{ status: 'success' }]),
      workspaceManager: new FakeWorkspaceManager(),
      config: testConfig({ tracker: TRACKER }),
      promptBuilder: new PromptBuilder('do'),
    });
    await expect(orch.switchProject(testConfig({ tracker: TRACKER }))).rejects.toThrow(/factories/);
  });

  it('applyConfig updates the live config without rebuilding the tracker', async () => {
    const tracker1 = memTracker([]);
    const orch = new Orchestrator({
      tracker: tracker1,
      backend: new MockBackend([{ status: 'success' }]),
      workspaceManager: new FakeWorkspaceManager(),
      config: testConfig({ agent: { max_concurrent_agents: 4 }, tracker: TRACKER }),
      promptBuilder: new PromptBuilder('do'),
    });
    orch.applyConfig(testConfig({ agent: { max_concurrent_agents: 9 }, tracker: TRACKER }));
    expect(orch.currentConfig().agent.max_concurrent_agents).toBe(9);
    expect(orch.currentTracker()).toBe(tracker1);
  });
});
