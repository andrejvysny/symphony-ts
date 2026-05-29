import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  CodingAgentBackend,
  RunOptions,
  RunResult,
} from '@symphony/agent-backends';
import { MemoryTracker } from '@symphony/tracker';
import { PromptBuilder } from '../prompt/builder.js';
import { FakeWorkspaceManager, MockBackend, makeIssue, testConfig } from '../test-support.js';
import { Orchestrator } from './orchestrator.js';

async function flush(o: Orchestrator): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 25; i++) await Promise.resolve();
    await o.settle();
  }
}

/** Backend that announces a tmux process then stays running until aborted. */
class TmuxRunningBackend implements CodingAgentBackend {
  readonly kind = 'claude-cli';
  async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const at = new Date(0).toISOString();
    yield { type: 'session_started', sessionId: 's', at };
    yield {
      type: 'process_started',
      pid: 999,
      ...(opts.tmux ? { tmuxSession: opts.tmux.sessionName } : {}),
      at,
    };
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    const result: RunResult = {
      status: 'success',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    yield { type: 'result', result, at };
    return result;
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(backend: CodingAgentBackend, agent: Record<string, unknown>) {
  const config = testConfig({
    agent: { max_turns: 1, stall_timeout_ms: 0, ...agent },
    tracker: { kind: 'memory', active_states: ['Todo'], terminal_states: ['Done'] },
  });
  const tracker = new MemoryTracker({
    issues: [makeIssue({ id: '1', identifier: 'ENG-1', state: 'Todo' })],
    activeStates: ['Todo'],
    terminalStates: ['Done'],
  });
  const orchestrator = new Orchestrator({
    tracker,
    backend,
    workspaceManager: new FakeWorkspaceManager(),
    config,
    promptBuilder: new PromptBuilder('do {{ issue.identifier }}'),
  });
  return orchestrator;
}

describe('tmux wiring', () => {
  it('passes tmux RunOptions to CLI backends and surfaces session + pid', async () => {
    const backend = new TmuxRunningBackend();
    const o = setup(backend, { backend: 'claude-cli', tmux: true });
    await o.runOnce();
    await flush(o);

    const sessions = o.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tmux_session).toBe('symphony-ENG-1');
    expect(sessions[0]?.pid).toBe(999);
    await o.terminate('1');
  });

  it('does not enable tmux for the in-process claude-sdk backend', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const o = setup(backend, { backend: 'claude-sdk', tmux: true });
    await o.runOnce();
    await flush(o);
    expect(backend.calls[0]?.tmux).toBeUndefined();
  });

  it('does not enable tmux when agent.tmux is false', async () => {
    const backend = new MockBackend([{ status: 'success' }]);
    const o = setup(backend, { backend: 'claude-cli', tmux: false });
    await o.runOnce();
    await flush(o);
    expect(backend.calls[0]?.tmux).toBeUndefined();
  });
});
