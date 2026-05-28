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

/** Let pending worker microtask chains resolve, then drain the mutation queue. */
async function flush(o: Orchestrator): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 25; i++) await Promise.resolve();
    await o.settle();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(opts: {
  issues: ReturnType<typeof makeIssue>[];
  backend: MockBackend | GatedBackend;
  config?: Record<string, unknown>;
}) {
  const config = testConfig({
    agent: { max_turns: 1, stall_timeout_ms: 0, ...((opts.config?.['agent'] as object) ?? {}) },
    tracker: {
      kind: 'memory',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done', 'Canceled'],
    },
    ...opts.config,
  });
  const tracker = new MemoryTracker({
    issues: opts.issues,
    activeStates: config.tracker.active_states,
    terminalStates: config.tracker.terminal_states,
  });
  const wm = new FakeWorkspaceManager();
  const orchestrator = new Orchestrator({
    tracker,
    backend: opts.backend,
    workspaceManager: wm,
    config,
    promptBuilder: new PromptBuilder('do {{ issue.identifier }}'),
  });
  return { orchestrator, tracker, wm, config };
}

describe('Orchestrator', () => {
  it('dispatches an active issue, completes, and schedules a continuation re-check', async () => {
    const backend = new MockBackend([{ status: 'success', tokens: { input: 100, output: 40 } }]);
    const { orchestrator, tracker } = setup({
      issues: [makeIssue({ id: '1', state: 'Todo' })],
      backend,
    });

    await orchestrator.runOnce();
    await flush(orchestrator);

    expect(backend.calls.length).toBe(1);
    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.completed).toBe(1);
    expect(snap.counts.retrying).toBe(1); // continuation re-check pending
    expect(snap.codex_totals.total_tokens).toBe(140);

    // Ticket reaches Done before the continuation fires → claim released, no re-dispatch.
    tracker.setState('1', 'Done');
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(orchestrator);
    expect(backend.calls.length).toBe(1);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it('moves an issue to blocked on input_required and releases it when terminal', async () => {
    const backend = new MockBackend([{ status: 'blocked', reason: 'need a decision' }]);
    const { orchestrator, tracker, wm } = setup({
      issues: [makeIssue({ id: '2', state: 'Todo' })],
      backend,
    });

    await orchestrator.runOnce();
    await flush(orchestrator);

    let snap = orchestrator.snapshot();
    expect(snap.counts.blocked).toBe(1);
    expect(snap.counts.retrying).toBe(0);
    expect(snap.blocked[0]!.reason).toContain('need a decision');

    tracker.setState('2', 'Done');
    await orchestrator.runOnce();
    await flush(orchestrator);
    snap = orchestrator.snapshot();
    expect(snap.counts.blocked).toBe(0);
    expect(wm.cleaned).toContain('2');
  });

  it('schedules an exponential-backoff retry on failure', async () => {
    const backend = new MockBackend([{ status: 'error_execution', error: 'boom' }]);
    const { orchestrator } = setup({ issues: [makeIssue({ id: '3', state: 'Todo' })], backend });

    await orchestrator.runOnce();
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.retrying).toBe(1);
    expect(snap.retrying[0]!.delay_type).toBe('failure');
    expect(snap.retrying[0]!.attempt).toBe(1);
  });

  it('enforces the global concurrency limit', async () => {
    const backend = new GatedBackend();
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'a', state: 'Todo' }), makeIssue({ id: 'b', state: 'Todo' })],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_concurrent_agents: 1 } },
    });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(1);
    expect(backend.running).toBe(1);

    backend.releaseAll();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(0);
  });

  it('terminates and cleans up a running issue that goes terminal', async () => {
    const backend = new GatedBackend();
    const { orchestrator, tracker, wm } = setup({
      issues: [makeIssue({ id: '4', state: 'Todo' })],
      backend,
    });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(1);

    tracker.setState('4', 'Done');
    await orchestrator.runOnce(); // reconcile detects terminal → aborts worker
    await flush(orchestrator);
    backend.releaseAll();
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(wm.cleaned).toContain('4');
  });

  it('kills a stalled worker and schedules a retry', async () => {
    const backend = new GatedBackend();
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 's', state: 'Todo' })],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 5_000 } },
    });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(1);

    await vi.advanceTimersByTimeAsync(6_000); // exceed stall timeout
    await orchestrator.runOnce(); // reconcile detects stall → aborts worker
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.retrying).toBe(1);
    expect(snap.retrying[0]!.delay_type).toBe('failure');
  });

  it('runs startup terminal cleanup before polling', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const { orchestrator, wm } = setup({
      issues: [makeIssue({ id: 'd1', state: 'Done' })],
      backend,
    });
    orchestrator.start();
    await flush(orchestrator);
    await orchestrator.stop();
    expect(wm.cleaned).toContain('d1');
  });

  it('increments the attempt across multiple failure retries (exponential backoff)', async () => {
    const backend = new MockBackend([{ status: 'error_execution', error: 'boom' }]); // always fails
    const { orchestrator } = setup({ issues: [makeIssue({ id: 'm', state: 'Todo' })], backend });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().retrying[0]!.attempt).toBe(1); // 10s

    await vi.advanceTimersByTimeAsync(10_000); // first failure retry fires → re-dispatch → fail again
    await flush(orchestrator);
    const snap = orchestrator.snapshot();
    expect(snap.retrying[0]!.attempt).toBe(2); // 20s
    expect(snap.retrying[0]!.delay_type).toBe('failure');
    expect(backend.calls.length).toBe(2);
  });

  it('releases a blocked issue that moves to a non-active (non-terminal) state without cleanup', async () => {
    const backend = new MockBackend([{ status: 'blocked', reason: 'need input' }]);
    const { orchestrator, tracker, wm } = setup({
      issues: [makeIssue({ id: 'nb', state: 'Todo' })],
      backend,
    });
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.blocked).toBe(1);

    tracker.setState('nb', 'Backlog'); // non-active, non-terminal
    await orchestrator.runOnce();
    await flush(orchestrator);
    const snap = orchestrator.snapshot();
    expect(snap.counts.blocked).toBe(0);
    expect(wm.cleaned).not.toContain('nb'); // released, not cleaned (not terminal)
  });

  it('requeues a retry as failure when no slots are available', async () => {
    // Backend: gate "G" forever (fills the only slot); fail "R" once.
    const gate = new GatedBackend();
    const routing = {
      kind: 'routing',
      run(opts: { issueRef?: { identifier: string } }) {
        if (opts.issueRef?.identifier === 'A') {
          return (async function* () {
            const at = new Date(0).toISOString();
            const result = {
              status: 'error_execution' as const,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              error: 'fail',
            };
            yield { type: 'turn_failed' as const, error: 'fail', at };
            yield { type: 'result' as const, result, at };
            return result;
          })();
        }
        return gate.run(opts as never);
      },
    };
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'A', state: 'Todo' }), makeIssue({ id: 'Z', state: 'Todo' })],
      backend: routing as never,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_concurrent_agents: 1 } },
    });

    await orchestrator.runOnce(); // dispatches A (sorts first) → fails → retry scheduled
    await flush(orchestrator);
    expect(orchestrator.snapshot().retrying.some((r) => r.issue_identifier === 'A')).toBe(true);

    await orchestrator.runOnce(); // dispatches Z → gated, fills the single slot
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000); // A's retry fires while the slot is full
    await flush(orchestrator);
    const a = orchestrator.snapshot().retrying.find((x) => x.issue_identifier === 'A');
    expect(a?.error).toContain('no available orchestrator slots');
    gate.releaseAll();
    await flush(orchestrator);
  });

  it('does not dispatch a Todo issue blocked by a non-terminal blocker', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const issue = makeIssue({
      id: '5',
      state: 'Todo',
      blockedBy: [{ id: 'x', identifier: 'X-1', state: 'In Progress' }],
    });
    const { orchestrator } = setup({ issues: [issue], backend });
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(backend.calls.length).toBe(0);
    expect(orchestrator.snapshot().counts.running).toBe(0);
  });
});
