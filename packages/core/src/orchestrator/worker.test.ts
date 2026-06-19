import { describe, expect, it } from 'vitest';
import { MemoryTracker } from '@symphony/tracker';
import { PromptBuilder } from '../prompt/builder.js';
import { FakeWorkspaceManager, MockBackend, makeIssue, testConfig } from '../test-support.js';
import { runWorker } from './worker.js';

const ctx = (issue: ReturnType<typeof makeIssue>) => ({
  issue,
  attempt: null,
  signal: new AbortController().signal,
  emit: () => {},
  onSession: () => {},
  onWorktree: () => {},
  onProcess: () => {},
});

describe('runWorker — one delegation + one nudge', () => {
  it('issues turn 1 as the full task and turn 2 as a finish-up nudge, then exhausts', async () => {
    // Succeeds every turn but never parks the issue for review → it stays active.
    const backend = new MockBackend([{ status: 'success' }]);
    const config = testConfig({
      agent: { max_turns: 2, stall_timeout_ms: 0, persist_run_log: false },
    });
    const issue = makeIssue({ id: 'nudge1', identifier: 'NUDGE-1', state: 'In Progress' });
    const tracker = new MemoryTracker({
      issues: [issue],
      activeStates: config.tracker.active_states,
      terminalStates: config.tracker.terminal_states,
    });

    const outcome = await runWorker(
      {
        tracker,
        workspaceManager: new FakeWorkspaceManager(),
        promptBuilder: new PromptBuilder('do {{ issue.identifier }}'),
        backend,
        config,
      },
      ctx(issue),
    );

    expect(backend.calls.length).toBe(2); // one delegation + exactly one nudge
    expect(backend.calls[0]!.prompt).toBe('do NUDGE-1'); // turn 1 = the rendered task
    const nudge = backend.calls[1]!.prompt;
    expect(nudge).toContain('stopped before parking'); // tailored finish-up nudge
    expect(nudge).not.toMatch(/turn \d+ of \d+/i); // no turn-budget framing
    // Still active after the nudge → exhausted (the orchestrator blocks at max_continuations=1).
    expect(outcome).toEqual({ kind: 'completed', disposition: 'exhausted' });
  });

  it('completes in a single delegation when the agent parks the issue (no nudge)', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const config = testConfig({
      agent: { max_turns: 2, stall_timeout_ms: 0, persist_run_log: false },
    });
    const issue = makeIssue({ id: 'one1', identifier: 'ONE-1', state: 'In Progress' });
    const tracker = new MemoryTracker({
      issues: [issue],
      activeStates: config.tracker.active_states,
      terminalStates: config.tracker.terminal_states,
    });
    // The agent parks it for review during turn 1 → leaves the active set.
    tracker.setState('one1', 'Human Review');

    const outcome = await runWorker(
      {
        tracker,
        workspaceManager: new FakeWorkspaceManager(),
        promptBuilder: new PromptBuilder('do {{ issue.identifier }}'),
        backend,
        config,
      },
      ctx(issue),
    );

    expect(backend.calls.length).toBe(1); // one delegation, no nudge
    expect(outcome).toEqual({ kind: 'completed', disposition: 'nonactive' });
  });
});
