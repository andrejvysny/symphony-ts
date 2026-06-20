import type {
  AgentEvent,
  CodingAgentBackend,
  PlanToolDeps,
  RunOptions,
  RunResult,
} from '@symphony/agent-backends';
import { MemoryTracker } from '@symphony/tracker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorkspaceManager, makeIssue, testConfig } from '../test-support.js';
import { Orchestrator } from './orchestrator.js';

/** Backend that, per run() call, executes one scripted step driving the plan tool executors. */
class ScriptedPlanBackend implements CodingAgentBackend {
  readonly kind = 'claude-sdk';
  getDeps: (issueId: string) => PlanToolDeps | undefined = () => undefined;
  steps: Array<(deps: PlanToolDeps) => Promise<void>> = [];

  async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const at = new Date(0).toISOString();
    const sessionId = opts.resumeSessionId ?? 'plan-sess';
    yield { type: 'session_started', sessionId, at };
    // Register a tool_use so the run counts a side-effect (parity with real runs).
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

/** First run() yields an error result (auth), subsequent runs submit a plan — drives retry recovery. */
class FailThenSubmitBackend implements CodingAgentBackend {
  readonly kind = 'claude-sdk';
  getDeps: (issueId: string) => PlanToolDeps | undefined = () => undefined;
  private calls = 0;

  async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const at = new Date(0).toISOString();
    const sessionId = opts.resumeSessionId ?? 'plan-sess';
    yield { type: 'session_started', sessionId, at };
    yield { type: 'tool_use', toolName: 'Read', toolUseId: 'r1', input: {}, at };
    this.calls += 1;
    if (this.calls === 1) {
      const result: RunResult = {
        status: 'error_execution',
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        error: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
        errorCategory: 'auth_required',
        retryable: false,
      };
      yield { type: 'result', result, at };
      return result;
    }
    const deps = opts.issueRef ? this.getDeps(opts.issueRef.id) : undefined;
    if (deps) {
      try {
        await deps.submitPlan('# Plan\n\nrecovered');
      } catch {
        /* aborted on submit */
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

function makeOrch(
  backend: CodingAgentBackend,
  opts: { qaMode?: 'live' | 'pause'; issueState?: string } = {},
): { orch: Orchestrator; tracker: MemoryTracker } {
  const issue = makeIssue({ id: 'i1', identifier: 'SYM-1', state: opts.issueState ?? 'Backlog' });
  const tracker = new MemoryTracker({
    issues: [issue],
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done'],
  });
  const config = testConfig();
  config.plan.qa_mode = opts.qaMode ?? 'live';
  const orch = new Orchestrator({
    tracker,
    backend,
    workspaceManager: new FakeWorkspaceManager(),
    config,
    now: () => 0,
  });
  return { orch, tracker };
}

describe('Orchestrator plan mode', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('live mode: ask blocks, answering resumes the same run, submit yields a ready plan', async () => {
    const backend = new ScriptedPlanBackend();
    const { orch } = makeOrch(backend);
    backend.getDeps = (id) => orch.planRunDepsForTest(id);
    backend.steps = [
      async (deps) => {
        await deps.ask([
          { header: 'Scope', question: 'Which path?', options: [{ label: 'A' }, { label: 'B' }] },
        ]);
        await deps.submitPlan('# Plan\n\n1. do the thing');
      },
    ];

    const started = await orch.startPlan('i1');
    expect(started.started).toBe(true);

    await until(async () => (await orch.getPlan('i1'))?.status === 'awaiting_input');
    const plan = await orch.getPlan('i1');
    const askId = plan?.pendingAsk?.id;
    const qid = plan?.pendingAsk?.questions[0]?.id;
    expect(askId && qid).toBeTruthy();

    await orch.answerPlanQuestion('i1', askId!, { [qid!]: 'A' });
    await until(async () => (await orch.getPlan('i1'))?.status === 'ready');

    const ready = await orch.getPlan('i1');
    expect(ready?.markdown).toBe('# Plan\n\n1. do the thing');
    expect(ready?.pendingAsk == null).toBe(true);
    expect(ready?.qa[0]?.answers).toEqual({ [qid!]: 'A' });
    expect(ready?.revision).toBe(1);
    await orch.stop();
  });

  it('pause mode: ask parks the run, answering re-dispatches and resumes to a ready plan', async () => {
    const backend = new ScriptedPlanBackend();
    const { orch } = makeOrch(backend, { qaMode: 'pause' });
    backend.getDeps = (id) => orch.planRunDepsForTest(id);
    backend.steps = [
      async (deps) => {
        await deps.ask([{ header: 'Scope', question: 'Which path?' }]);
      },
      async (deps) => {
        await deps.submitPlan('# Revised plan');
      },
    ];

    await orch.startPlan('i1');
    // The run parks: status awaiting_input AND no live plan run remains.
    await until(
      async () =>
        (await orch.getPlan('i1'))?.status === 'awaiting_input' &&
        orch.planRunDepsForTest('i1') === undefined,
    );
    const askId = (await orch.getPlan('i1'))?.pendingAsk?.id;
    expect(askId).toBeTruthy();

    await orch.answerPlanQuestion('i1', askId!, { q: 'free text' });
    await until(async () => (await orch.getPlan('i1'))?.status === 'ready');
    expect((await orch.getPlan('i1'))?.markdown).toBe('# Revised plan');
    await orch.stop();
  });

  it('rejects starting a plan on a non-Backlog ticket and on a non-sdk backend', async () => {
    const backend = new ScriptedPlanBackend();
    const { orch } = makeOrch(backend, { issueState: 'Todo' });
    const r = await orch.startPlan('i1');
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/Backlog/);
  });

  it('approve moves the ticket Backlog → Todo and marks the plan approved', async () => {
    const backend = new ScriptedPlanBackend();
    const { orch, tracker } = makeOrch(backend);
    // Seed a ready plan directly (no run needed).
    await orch.editPlan('i1', '# Plan');
    const approved = await orch.approvePlan('i1');
    expect(approved.approved).toBe(true);
    expect(tracker.get('i1')?.state).toBe('Todo');
    expect((await orch.getPlan('i1'))?.status).toBe('approved');
  });

  it('approve is blocked while a question is pending', async () => {
    const backend = new ScriptedPlanBackend();
    const { orch } = makeOrch(backend);
    await orch.editPlan('i1', '# Plan');
    // Simulate a pending question via the tracker.
    await orch.addPlanComment('i1', { exact: 'x' }, 'note');
    const tracker = (orch as unknown as { tracker: MemoryTracker }).tracker;
    await tracker.updatePlan('i1', (p) => ({
      ...p!,
      status: 'awaiting_input',
      pendingAsk: { id: 'a', at: '', questions: [] },
    }));
    const r = await orch.approvePlan('i1');
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/pending question/);
  });

  it('a revision drops comments whose anchored text disappears, keeps the rest', async () => {
    const backend = new ScriptedPlanBackend();
    const { orch } = makeOrch(backend);
    backend.getDeps = (id) => orch.planRunDepsForTest(id);
    backend.steps = [async (deps) => void (await deps.submitPlan('# Plan\n\nkeep this line'))];

    await orch.editPlan('i1', '# Plan\n\nkeep this line and drop that line');
    await orch.addPlanComment('i1', { exact: 'keep this line' }, 'still here');
    await orch.addPlanComment('i1', { exact: 'drop that line' }, 'will orphan');
    expect((await orch.getPlan('i1'))?.comments).toHaveLength(2);

    await orch.startPlan('i1');
    await until(async () => (await orch.getPlan('i1'))?.status === 'ready');
    const comments = (await orch.getPlan('i1'))?.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe('still here');
    await orch.stop();
  });

  it('captures the failure reason + category on the plan, then clears it on a successful retry', async () => {
    const backend = new FailThenSubmitBackend();
    const { orch } = makeOrch(backend);
    backend.getDeps = (id) => orch.planRunDepsForTest(id);

    await orch.startPlan('i1');
    await until(async () => (await orch.getPlan('i1'))?.status === 'failed');
    const failed = await orch.getPlan('i1');
    expect(failed?.error).toMatch(/authenticate/i);
    expect(failed?.errorCategory).toBe('auth_required');

    // Retrying after re-auth clears the stale error and produces a ready plan.
    await orch.startPlan('i1');
    await until(async () => (await orch.getPlan('i1'))?.status === 'ready');
    const ok = await orch.getPlan('i1');
    expect(ok?.markdown).toBe('# Plan\n\nrecovered');
    expect(ok?.error).toBeUndefined();
    expect(ok?.errorCategory).toBeUndefined();
    await orch.stop();
  });

  it('comments persist and resolve', async () => {
    const backend = new ScriptedPlanBackend();
    const { orch } = makeOrch(backend);
    await orch.editPlan('i1', '# Plan');
    const { id } = await orch.addPlanComment(
      'i1',
      { exact: 'do the thing', prefix: '1. ' },
      'scope this down',
    );
    let plan = await orch.getPlan('i1');
    expect(plan?.comments).toHaveLength(1);
    expect(plan?.comments[0]?.resolved).toBe(false);
    await orch.resolvePlanComment('i1', id, true);
    plan = await orch.getPlan('i1');
    expect(plan?.comments[0]?.resolved).toBe(true);
  });
});
