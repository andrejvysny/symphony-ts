import type {
  AgentEvent,
  CodingAgentBackend,
  OrderToolDeps,
  RunOptions,
  RunResult,
} from '@symphony/agent-backends';
import { MemoryTracker } from '@symphony/tracker';
import type { NormalizedIssue } from '@symphony/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorkspaceManager, makeIssue, testConfig } from '../test-support.js';
import { Orchestrator } from './orchestrator.js';

/** Backend that, per run() call, executes one scripted step driving the order tool executors. */
class ScriptedOrderBackend implements CodingAgentBackend {
  readonly kind = 'claude-sdk';
  getDeps: (runId: string) => OrderToolDeps | undefined = () => undefined;
  steps: Array<(deps: OrderToolDeps) => Promise<void>> = [];

  async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const at = new Date(0).toISOString();
    const sessionId = opts.resumeSessionId ?? 'order-sess';
    yield { type: 'session_started', sessionId, at };
    yield { type: 'tool_use', toolName: 'Read', toolUseId: 'r1', input: {}, at };
    const deps = opts.issueRef ? this.getDeps(opts.issueRef.id) : undefined;
    const step = this.steps.shift();
    if (deps && step) {
      try {
        await step(deps);
      } catch {
        /* aborted on submit/park */
      }
    }
    const result: RunResult = {
      status: 'success',
      sessionId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    yield { type: 'result', result, at };
    return result;
  }
}

async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function backlog(id: string, identifier: string): NormalizedIssue {
  return makeIssue({ id, identifier, state: 'Backlog' });
}

function makeOrch(
  backend: CodingAgentBackend,
  opts: { issues?: NormalizedIssue[]; qaMode?: 'live' | 'pause' } = {},
): { orch: Orchestrator; tracker: MemoryTracker } {
  const issues = opts.issues ?? [
    backlog('a', 'SYM-1'),
    backlog('b', 'SYM-2'),
    backlog('c', 'SYM-3'),
  ];
  const tracker = new MemoryTracker({
    issues,
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done'],
  });
  const config = testConfig();
  config.order.qa_mode = opts.qaMode ?? 'live';
  // Backlog is the entry-lane source; Todo is active_states[0].
  config.tracker.backlog_state = 'Backlog';
  const orch = new Orchestrator({
    tracker,
    backend,
    workspaceManager: new FakeWorkspaceManager(),
    config,
    now: () => 0,
  });
  return { orch, tracker };
}

describe('Orchestrator sequence (order) mode', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('submits an order, approve commits rank + blockedBy and moves the batch to Todo', async () => {
    const backend = new ScriptedOrderBackend();
    const { orch, tracker } = makeOrch(backend);
    backend.getDeps = (id) => orch.orderRunDepsForTest(id);
    backend.steps = [
      async (deps) => {
        await deps.submitOrder({
          order: ['a', 'b', 'c'],
          tickets: [
            { id: 'a', blockedBy: [], rationale: 'foundation' },
            { id: 'b', blockedBy: ['a'], rationale: 'needs a' },
            { id: 'c', blockedBy: ['a', 'b'], rationale: 'needs a+b' },
          ],
          summary: 'a → b → c',
        });
      },
    ];

    const started = await orch.startOrder(['a', 'b', 'c']);
    expect(started.started).toBe(true);
    const runId = started.runId!;
    await until(async () => (await orch.getOrder(runId))?.status === 'ready');
    const ready = await orch.getOrder(runId);
    expect(ready?.proposal?.order).toEqual(['a', 'b', 'c']);

    const approved = await orch.approveOrder(runId);
    expect(approved.approved).toBe(true);
    expect(approved.applied).toBe(3);
    expect(approved.released).toBe(true);

    // rank committed in order; blockedBy edges filtered to preceding tickets; all moved to Todo.
    const all = await tracker.fetchAllIssues();
    const byId = new Map(all.map((i) => [i.id, i]));
    expect(byId.get('a')?.rank).toBe(0);
    expect(byId.get('b')?.rank).toBe(1);
    expect(byId.get('c')?.rank).toBe(2);
    expect(byId.get('a')?.state).toBe('Todo');
    expect(byId.get('a')?.blockedBy).toEqual([]);
    expect(byId.get('b')?.blockedBy.map((x) => x.id)).toEqual(['a']);
    expect(byId.get('c')?.blockedBy.map((x) => x.id)).toEqual(['a', 'b']);
    expect((await orch.getOrder(runId))?.status).toBe('approved');
    await orch.stop();
  });

  it('apply with release=false commits rank + blockedBy but keeps the tickets in Backlog', async () => {
    const backend = new ScriptedOrderBackend();
    const { orch, tracker } = makeOrch(backend);
    backend.getDeps = (id) => orch.orderRunDepsForTest(id);
    backend.steps = [
      async (deps) => {
        await deps.submitOrder({
          order: ['a', 'b', 'c'],
          tickets: [
            { id: 'a', blockedBy: [], rationale: 'foundation' },
            { id: 'b', blockedBy: ['a'], rationale: 'needs a' },
            { id: 'c', blockedBy: ['b'], rationale: 'needs b' },
          ],
          summary: 'a → b → c',
        });
      },
    ];
    const started = await orch.startOrder(['a', 'b', 'c']);
    const runId = started.runId!;
    await until(async () => (await orch.getOrder(runId))?.status === 'ready');

    const applied = await orch.approveOrder(runId, undefined, false);
    expect(applied.approved).toBe(true);
    expect(applied.applied).toBe(3);
    expect(applied.released).toBe(false);

    const byId = new Map((await tracker.fetchAllIssues()).map((i) => [i.id, i]));
    // rank + dependencies are committed (badges show) but the tickets stay in Backlog (not queued).
    expect(byId.get('a')?.rank).toBe(0);
    expect(byId.get('b')?.rank).toBe(1);
    expect(byId.get('b')?.blockedBy.map((x) => x.id)).toEqual(['a']);
    expect(byId.get('a')?.state).toBe('Backlog');
    expect(byId.get('b')?.state).toBe('Backlog');
    expect(byId.get('c')?.state).toBe('Backlog');
    expect((await orch.getOrder(runId))?.released).toBe(false);
    await orch.stop();
  });

  it('an operator override that reorders drops the now-inconsistent dependency edge', async () => {
    const backend = new ScriptedOrderBackend();
    const { orch, tracker } = makeOrch(backend);
    backend.getDeps = (id) => orch.orderRunDepsForTest(id);
    backend.steps = [
      async (deps) => {
        await deps.submitOrder({
          order: ['a', 'b'],
          tickets: [
            { id: 'a', blockedBy: ['b'], rationale: 'a needs b' },
            { id: 'b', blockedBy: [], rationale: 'first' },
          ],
          summary: 'b → a',
        });
      },
    ];
    const started = await orch.startOrder(['a', 'b']);
    const runId = started.runId!;
    await until(async () => (await orch.getOrder(runId))?.status === 'ready');

    // Operator drags a BEFORE b — the edge "a blocked by b" is now inconsistent and must be dropped.
    await orch.approveOrder(runId, ['a', 'b']);
    const byId = new Map((await tracker.fetchAllIssues()).map((i) => [i.id, i]));
    expect(byId.get('a')?.rank).toBe(0);
    expect(byId.get('a')?.blockedBy).toEqual([]); // dropped (would have been a cycle/contradiction)
    expect(byId.get('b')?.rank).toBe(1);
    await orch.stop();
  });

  it('rejects a subset that is too small, non-backlog, or unknown', async () => {
    const backend = new ScriptedOrderBackend();
    const { orch } = makeOrch(backend, {
      issues: [backlog('a', 'SYM-1'), makeIssue({ id: 'x', identifier: 'SYM-9', state: 'Todo' })],
    });
    expect((await orch.startOrder(['a'])).reason).toMatch(/at least 2/);
    expect((await orch.startOrder(['a', 'x'])).reason).toMatch(/SYM-9 is not in Backlog/);
    expect((await orch.startOrder(['a', 'zzz'])).reason).toMatch(/not found/);
    await orch.stop();
  });

  it('a self-correctable submission error keeps the run open (isError, not persisted)', async () => {
    const backend = new ScriptedOrderBackend();
    const { orch } = makeOrch(backend);
    backend.getDeps = (id) => orch.orderRunDepsForTest(id);
    let firstResult: { ok: boolean; text: string } | undefined;
    backend.steps = [
      async (deps) => {
        // Missing ticket 'c' → structural failure; tool returns isError; run continues then submits.
        firstResult = await deps.submitOrder({
          order: ['a', 'b'],
          tickets: [
            { id: 'a', blockedBy: [], rationale: 'x' },
            { id: 'b', blockedBy: [], rationale: 'y' },
          ],
          summary: 's',
        });
        await deps.submitOrder({
          order: ['a', 'b', 'c'],
          tickets: [
            { id: 'a', blockedBy: [], rationale: 'x' },
            { id: 'b', blockedBy: [], rationale: 'y' },
            { id: 'c', blockedBy: [], rationale: 'z' },
          ],
          summary: 's',
        });
      },
    ];
    const started = await orch.startOrder(['a', 'b', 'c']);
    const runId = started.runId!;
    await until(async () => (await orch.getOrder(runId))?.status === 'ready');
    expect(firstResult?.ok).toBe(false);
    expect(firstResult?.text).toMatch(/missing: c/);
    expect((await orch.getOrder(runId))?.proposal?.order).toEqual(['a', 'b', 'c']);
    await orch.stop();
  });
});
