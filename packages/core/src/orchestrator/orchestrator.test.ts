import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingAgentBackend } from '@symphony/agent-backends';
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
  backend: CodingAgentBackend;
  config?: Record<string, unknown>;
}) {
  const config = testConfig({
    // Permissive continuation cap by default so tests exercising the continuation path aren't blocked
    // by the production default of 1; cap-specific tests set max_continuations explicitly.
    agent: {
      max_turns: 1,
      stall_timeout_ms: 0,
      max_continuations: 50,
      ...((opts.config?.['agent'] as object) ?? {}),
    },
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

  it('persists per-task token usage onto the issue on worker exit', async () => {
    const backend = new MockBackend([{ status: 'success', tokens: { input: 100, output: 40 } }]);
    const { orchestrator, tracker } = setup({
      issues: [makeIssue({ id: '1', state: 'Todo' })],
      backend,
    });

    await orchestrator.runOnce();
    await flush(orchestrator);

    const issue = (await tracker.fetchAllIssues()).find((i) => i.id === '1');
    expect(issue?.usage?.totalTokens).toBe(140);
    expect(issue?.usage?.inputTokens).toBe(100);
    expect(issue?.usage?.outputTokens).toBe(40);
  });

  it('moves a freshly picked-up entry-lane issue to In Progress immediately', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const { orchestrator, tracker } = setup({
      issues: [makeIssue({ id: '1', state: 'Todo' })],
      backend,
    });

    await orchestrator.runOnce();
    await flush(orchestrator);

    // The orchestrator pre-moves Todo → In Progress on pickup so the board shows work immediately.
    const issue = (await tracker.fetchAllIssues()).find((i) => i.id === '1');
    expect(issue?.state).toBe('In Progress');
  });

  it('does not auto-move a non-entry active state (Rework) on pickup', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const { orchestrator, tracker } = setup({
      issues: [makeIssue({ id: '9', state: 'Rework' })],
      backend,
      config: {
        tracker: {
          kind: 'memory',
          active_states: ['Todo', 'In Progress', 'Rework'],
          terminal_states: ['Done', 'Canceled'],
        },
      },
    });

    await orchestrator.runOnce();
    await flush(orchestrator);

    // Only the entry lane auto-moves — agent-advanced states are never stomped.
    const issue = (await tracker.fetchAllIssues()).find((i) => i.id === '9');
    expect(issue?.state).toBe('Rework');
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

  it('unblock() clears a blocked-but-active issue so it is re-dispatched', async () => {
    const backend = new MockBackend([
      { status: 'blocked', reason: 'need input' },
      { status: 'success' },
    ]);
    const { orchestrator } = setup({ issues: [makeIssue({ id: 'b1', state: 'Todo' })], backend });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.blocked).toBe(1);

    // Operator clears the block while the ticket is still active (no tracker bounce).
    expect(await orchestrator.unblock('b1')).toEqual({ unblocked: true });
    expect(orchestrator.snapshot().counts.blocked).toBe(0);

    // Next poll re-dispatches it (2nd scripted turn succeeds).
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(backend.calls.length).toBe(2);

    // Unblocking something not blocked is a no-op.
    expect(await orchestrator.unblock('b1')).toEqual({ unblocked: false });
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

  it('blocks a non-retryable failure instead of retrying it (R2)', async () => {
    const backend = new MockBackend([
      {
        status: 'error_execution',
        error: 'spawn claude ENOENT',
        category: 'agent_not_found',
        retryable: false,
      },
    ]);
    const { orchestrator } = setup({ issues: [makeIssue({ id: 'nr', state: 'Todo' })], backend });

    await orchestrator.runOnce();
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.retrying).toBe(0); // not retried
    expect(snap.counts.blocked).toBe(1);
    expect(snap.blocked[0]!.reason).toContain('non-retryable');
    expect(snap.blocked[0]!.reason).toContain('agent_not_found');
    expect(backend.calls.length).toBe(1); // ran exactly once
  });

  it('blocks a retryable failure once the failure-retry cap is exhausted (R2)', async () => {
    const backend = new MockBackend([
      { status: 'error_execution', error: 'boom', retryable: true },
    ]);
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'cap', state: 'Todo' })],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_failure_retries: 2 } },
    });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().retrying[0]!.attempt).toBe(1); // fail #1 → retry attempt 1

    // Drive all scheduled retries to completion. Jittered timers can cascade within one window,
    // so loop generously rather than asserting exact intermediate attempt counts.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await flush(orchestrator);
    }

    const snap = orchestrator.snapshot();
    expect(snap.counts.retrying).toBe(0);
    expect(snap.counts.blocked).toBe(1);
    expect(snap.blocked[0]!.reason).toContain('failed after 2 retries');
    // dispatch(0)=fail#1 → retry attempt1=fail#2 → retry attempt2=fail#3 → attempt 3 > cap 2 → blocked
    expect(backend.calls.length).toBe(3);
  });

  it('resumes the agent session on a re-dispatch after a resumable failure with side-effects (R4)', async () => {
    const backend = new MockBackend([
      { status: 'error_execution', error: 'upstream blip', retryable: true, sideEffect: true },
      { status: 'success' },
    ]);
    const { orchestrator } = setup({ issues: [makeIssue({ id: 'rs', state: 'Todo' })], backend });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.retrying).toBe(1); // fail #1 scheduled retry

    await vi.advanceTimersByTimeAsync(60_000); // retry fires → re-dispatch (then continuations)
    await flush(orchestrator);

    // calls[1] is the failure-retry re-dispatch (continuations come after); it must resume the session.
    expect(backend.calls.length).toBeGreaterThanOrEqual(2);
    expect(backend.calls[1]!.resumeSessionId).toBe('sess-1');
  });

  it('does NOT resume after a failure with no side-effects (cold restart) (R4)', async () => {
    const backend = new MockBackend([
      {
        status: 'error_execution',
        error: 'died before doing anything',
        retryable: true,
        sideEffect: false,
      },
      { status: 'success' },
    ]);
    const { orchestrator } = setup({ issues: [makeIssue({ id: 'cold', state: 'Todo' })], backend });

    await orchestrator.runOnce();
    await flush(orchestrator);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush(orchestrator);

    // calls[1] is the re-dispatch after the no-side-effect failure → must start cold (no resume).
    expect(backend.calls.length).toBeGreaterThanOrEqual(2);
    expect(backend.calls[1]!.resumeSessionId).toBeUndefined();
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

  it('runs 3 issues concurrently with per-issue session + token isolation (no cross-wiring)', async () => {
    const tokenFor = (id: string): number => ({ i1: 100, i2: 200, i3: 300 })[id] ?? 0;
    const releasers: Array<() => void> = [];
    const backend: CodingAgentBackend = {
      kind: 'iso',
      async *run(opts) {
        const at = new Date(0).toISOString();
        const id = opts.issueRef?.id ?? '?';
        const t = tokenFor(id);
        yield { type: 'session_started', sessionId: `sess-${id}`, at };
        yield {
          type: 'usage',
          inputTokens: t,
          outputTokens: 0,
          totalTokens: t,
          absolute: true,
          at,
        };
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
          releasers.push(resolve);
        });
        const result = {
          status: 'success' as const,
          sessionId: `sess-${id}`,
          inputTokens: t,
          outputTokens: 0,
          totalTokens: t,
        };
        yield { type: 'turn_completed', at };
        yield { type: 'result', result, at };
        return result;
      },
    };
    const { orchestrator } = setup({
      issues: [
        makeIssue({ id: 'i1', state: 'Todo' }),
        makeIssue({ id: 'i2', state: 'Todo' }),
        makeIssue({ id: 'i3', state: 'Todo' }),
      ],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_concurrent_agents: 3 } },
    });

    await orchestrator.runOnce();
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(3);
    const byId = Object.fromEntries(snap.running.map((r) => [r.issue_id, r]));
    expect(byId['i1']?.tokens.total_tokens).toBe(100);
    expect(byId['i2']?.tokens.total_tokens).toBe(200);
    expect(byId['i3']?.tokens.total_tokens).toBe(300);
    // Distinct sessions per issue — events were not cross-wired.
    expect(new Set(snap.running.map((r) => r.session_id)).size).toBe(3);

    for (const r of releasers.splice(0)) r();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(0);
    expect(orchestrator.snapshot().codex_totals.total_tokens).toBe(600);
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

  // A backend that flips the ticket to `finalState` during its turn (as a real agent would via
  // linear_graphql), so the worker's post-success state refetch observes the new state.
  function stateChangingBackend(tracker: MemoryTracker, id: string, finalState: string) {
    return {
      kind: 'state-changing',
      async *run() {
        const at = new Date(0).toISOString();
        yield { type: 'session_started', sessionId: 's', at };
        tracker.setState(id, finalState);
        const result = {
          status: 'success' as const,
          sessionId: 's',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        yield { type: 'turn_completed' as const, at };
        yield { type: 'result' as const, result, at };
        return result;
      },
    };
  }

  function manualSetup(
    tracker: MemoryTracker,
    backend: unknown,
    config: ReturnType<typeof testConfig>,
  ) {
    const wm = new FakeWorkspaceManager();
    const orchestrator = new Orchestrator({
      tracker,
      backend: backend as never,
      workspaceManager: wm,
      config,
      promptBuilder: new PromptBuilder('do {{ issue.identifier }}'),
    });
    return { orchestrator, wm };
  }

  it('cleans up and does not continue when a turn ends with the issue terminal', async () => {
    const config = testConfig({
      agent: { max_turns: 1, stall_timeout_ms: 0 },
      tracker: {
        kind: 'memory',
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done', 'Canceled'],
      },
    });
    const tracker = new MemoryTracker({
      issues: [makeIssue({ id: 't1', state: 'Todo' })],
      activeStates: config.tracker.active_states,
      terminalStates: config.tracker.terminal_states,
    });
    const { orchestrator, wm } = manualSetup(
      tracker,
      stateChangingBackend(tracker, 't1', 'Done'),
      config,
    );

    await orchestrator.runOnce();
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.retrying).toBe(0); // no continuation re-check
    expect(snap.counts.completed).toBe(1);
    expect(wm.cleaned).toContain('t1'); // cleaned immediately on terminal completion
  });

  it('releases without cleanup when a turn ends with the issue non-active (non-terminal)', async () => {
    const config = testConfig({
      agent: { max_turns: 1, stall_timeout_ms: 0 },
      tracker: {
        kind: 'memory',
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done', 'Canceled'],
      },
    });
    const tracker = new MemoryTracker({
      issues: [makeIssue({ id: 'na', state: 'Todo' })],
      activeStates: config.tracker.active_states,
      terminalStates: config.tracker.terminal_states,
    });
    const { orchestrator, wm } = manualSetup(
      tracker,
      stateChangingBackend(tracker, 'na', 'Backlog'),
      config,
    );

    await orchestrator.runOnce();
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.retrying).toBe(0);
    expect(snap.counts.completed).toBe(0); // not a real completion
    expect(wm.cleaned).not.toContain('na'); // preserved (not terminal)
  });

  it('blocks an issue after the continuation cap without a terminal state', async () => {
    const backend = new MockBackend([{ status: 'success' }]); // always succeeds; issue stays active
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'c1', state: 'Todo' })],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_continuations: 2 } },
    });

    await orchestrator.runOnce(); // dispatch #1 → exhausted → continuations=1, continuation scheduled
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.retrying).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000); // continuation fires → dispatch #2 → continuations=2 == cap
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(snap.counts.blocked).toBe(1);
    expect(snap.counts.retrying).toBe(0);
    expect(snap.blocked[0]!.reason).toContain('continuation cap');
    expect(backend.calls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000); // blocked → no further re-dispatch
    await flush(orchestrator);
    expect(backend.calls.length).toBe(2);
  });

  it('blocks on the first exhaustion at the default continuation cap (max_continuations: 1)', async () => {
    const backend = new MockBackend([{ status: 'success' }]); // succeeds but never parks → stays active
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'b1', state: 'Todo' })],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_continuations: 1 } },
    });

    await orchestrator.runOnce(); // dispatch → exhausted → continuations=1 == cap → block, no re-dispatch
    await flush(orchestrator);

    const snap = orchestrator.snapshot();
    expect(backend.calls.length).toBe(1);
    expect(snap.counts.blocked).toBe(1);
    expect(snap.counts.retrying).toBe(0);
    expect(snap.blocked[0]!.reason).toContain('continuation cap');

    await vi.advanceTimersByTimeAsync(5_000); // stays blocked — no further dispatch
    await flush(orchestrator);
    expect(backend.calls.length).toBe(1);
  });

  it('treats max_continuations: 0 as unlimited', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'u1', state: 'Todo' })],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_continuations: 0 } },
    });

    await orchestrator.runOnce();
    await flush(orchestrator);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1_000); // continuation re-checks keep firing
      await flush(orchestrator);
    }

    const snap = orchestrator.snapshot();
    expect(snap.counts.blocked).toBe(0);
    expect(snap.counts.retrying).toBe(1); // still scheduling continuations
    expect(backend.calls.length).toBeGreaterThan(2);
  });

  it('does not dispatch an issue blocked by a non-terminal blocker', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    // The blocker is a real, live ticket in a non-active, non-terminal lane (Backlog) so it both
    // gates issue 5 and is not itself dispatched. Its blockedBy snapshot is stale ('In Progress'),
    // proving the dispatch gate uses the blocker's CURRENT state (refreshed in fetchCandidateIssues).
    const blocker = makeIssue({ id: 'x', identifier: 'X-1', state: 'Backlog' });
    const issue = makeIssue({
      id: '5',
      state: 'Todo',
      blockedBy: [{ id: 'x', identifier: 'X-1', state: 'In Progress' }],
    });
    const { orchestrator } = setup({ issues: [blocker, issue], backend });
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(backend.calls.length).toBe(0);
    expect(orchestrator.snapshot().counts.running).toBe(0);
  });

  it('terminates a running session, holds it from re-dispatch, and resumes on demand', async () => {
    const backend = new GatedBackend();
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'term1', state: 'Todo' })],
      backend,
    });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(1);
    expect(orchestrator.listSessions()).toHaveLength(1);

    await orchestrator.terminate('term1');
    await flush(orchestrator);
    let snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(0);
    expect(snap.counts.paused).toBe(1);
    expect(backend.running).toBe(0);

    // held from re-dispatch while paused
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(0);

    // resume → eligible again
    orchestrator.resume('term1');
    await orchestrator.runOnce();
    await flush(orchestrator);
    snap = orchestrator.snapshot();
    expect(snap.counts.running).toBe(1);
    expect(snap.counts.paused).toBe(0);
    backend.releaseAll();
    await flush(orchestrator);
  });

  it('terminateAll stops every running session', async () => {
    const backend = new GatedBackend();
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'ta', state: 'Todo' }), makeIssue({ id: 'tb', state: 'Todo' })],
      backend,
      config: { agent: { max_turns: 1, stall_timeout_ms: 0, max_concurrent_agents: 2 } },
    });
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(2);

    const res = await orchestrator.terminateAll();
    await flush(orchestrator);
    expect(res.terminated).toBe(2);
    expect(orchestrator.snapshot().counts.running).toBe(0);
    expect(orchestrator.snapshot().counts.paused).toBe(2);
  });

  it('streams live session events to subscribers and buffers them', async () => {
    const gated = new GatedBackend();
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'g1', state: 'Todo' })],
      backend: gated,
    });
    await orchestrator.runOnce();
    await flush(orchestrator);

    // buffer holds the backlog; a late subscriber replays it
    expect(orchestrator.getSessionLogs('g1').map((e) => e.type)).toContain('session_started');
    const replayed: string[] = [];
    orchestrator.subscribeLogs('g1', (e) => replayed.push(e.type));
    expect(replayed).toContain('session_started');
    await orchestrator.terminate('g1');
    await flush(orchestrator);

    // live streaming across a full mock run
    const live: string[] = [];
    const o2 = setup({
      issues: [makeIssue({ id: 'L1', state: 'Todo' })],
      backend: new MockBackend([{ status: 'success' }]),
    }).orchestrator;
    o2.subscribeLogs('L1', (e) => live.push(e.type));
    await o2.runOnce();
    await flush(o2);
    expect(live).toContain('turn_completed');
  });

  it('single_dir mode runs one task at a time (serial clamp)', async () => {
    const backend = new GatedBackend();
    const { orchestrator } = setup({
      issues: [makeIssue({ id: 'a', state: 'Todo' }), makeIssue({ id: 'b', state: 'Todo' })],
      backend,
      // High max_concurrent_agents, but single_dir clamps to 1.
      config: {
        agent: { max_turns: 1, stall_timeout_ms: 0, max_concurrent_agents: 10 },
        workspace: { mode: 'single_dir', repo: '/tmp/fake-repo', root: '/tmp/fake-ws' },
      },
    });

    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(1);
    expect(backend.running).toBe(1);

    backend.releaseAll();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(0);
  });

  it('notifies board subscribers after a settled mutation', async () => {
    const { orchestrator } = setup({
      issues: [makeIssue({ id: '1', state: 'Todo' })],
      backend: new MockBackend([{ status: 'success' }]),
    });
    let hits = 0;
    const unsub = orchestrator.subscribeBoard(() => {
      hits += 1;
    });
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(hits).toBeGreaterThan(0);
    unsub();
    const before = hits;
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(hits).toBe(before); // unsubscribed → no more callbacks
  });

  it('merges the issue branch into base, then cleans up, when an issue is accepted', async () => {
    const backend = new GatedBackend();
    const { orchestrator, tracker, wm } = setup({
      issues: [makeIssue({ id: '1', state: 'Todo' })],
      backend,
    });
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(orchestrator.snapshot().counts.running).toBe(1);

    // Operator accepts: tracker state → Done. Next reconcile aborts + finalizes.
    tracker.setState('1', 'Done');
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(wm.integrated).toContain('1'); // merged on accept
    expect(wm.cleaned).toContain('1'); // then cleaned up
  });

  it('does not merge a discarded (cancelled) issue, but still cleans up', async () => {
    const backend = new GatedBackend();
    const { orchestrator, tracker, wm } = setup({
      issues: [makeIssue({ id: '1', state: 'Todo' })],
      backend,
    });
    await orchestrator.runOnce();
    await flush(orchestrator);

    tracker.setState('1', 'Canceled');
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(wm.integrated).not.toContain('1'); // cancel-type → no merge
    expect(wm.cleaned).toContain('1');
  });

  it('preserves the workspace + surfaces a merge failure on conflict', async () => {
    const backend = new GatedBackend();
    const { orchestrator, tracker, wm } = setup({
      issues: [makeIssue({ id: '1', state: 'Todo' })],
      backend,
    });
    wm.integrateResult = { merged: false, conflict: true, reason: 'merge conflict' };
    await orchestrator.runOnce();
    await flush(orchestrator);

    tracker.setState('1', 'Done');
    await orchestrator.runOnce();
    await flush(orchestrator);
    expect(wm.integrated).toContain('1');
    expect(wm.cleaned).not.toContain('1'); // conflict → keep the branch + worktree
    expect(orchestrator.snapshot().merge_failures.map((m) => m.issue_id)).toContain('1');
  });
});
