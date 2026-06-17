import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, RunOptions, RunResult } from '../backend.js';

// Mock the SDK's `query` (the only runtime symbol the backend imports) so these tests
// run in CI with no live `claude` login. vi.hoisted keeps the mock fn above the import.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { ClaudeCodeSdkBackend } = await import('./claude-sdk-backend.js');

async function* fromArray(msgs: unknown[]): AsyncGenerator<unknown> {
  for (const m of msgs) yield m;
}

async function drain(opts: RunOptions): Promise<{ events: AgentEvent[]; result: RunResult }> {
  const backend = new ClaudeCodeSdkBackend();
  const events: AgentEvent[] = [];
  const gen = backend.run(opts);
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

const SUCCESS = [
  { type: 'system', subtype: 'init', session_id: 's1' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.01,
    num_turns: 1,
  },
];

const base: RunOptions = { prompt: 'do it', cwd: process.cwd() };

describe('ClaudeCodeSdkBackend', () => {
  it('builds a FRESH MCP server per run (concurrency: never share one instance)', async () => {
    queryMock.mockImplementation(() => fromArray(SUCCESS));
    const instances: Array<Record<string, unknown>> = [];
    const factory = vi.fn(() => {
      const inst = { symphony: { token: instances.length } };
      instances.push(inst);
      return inst;
    });

    const r1 = await drain({ ...base, mcpConfig: { sdkServers: factory } });
    expect(r1.result.status).toBe('success');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]![0].options.mcpServers).toBe(instances[0]);

    await drain({ ...base, mcpConfig: { sdkServers: factory } });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(instances[0]).not.toBe(instances[1]);
    expect(queryMock.mock.calls[1]![0].options.mcpServers).toBe(instances[1]);
  });

  it('maps a successful run to usage + turn_completed + success result', async () => {
    queryMock.mockImplementation(() => fromArray(SUCCESS));
    const { events, result } = await drain(base);
    const types = events.map((e) => e.type);
    expect(types).toContain('session_started');
    expect(types).toContain('text_delta');
    expect(types).toContain('usage');
    expect(types).toContain('turn_completed');
    expect(result.status).toBe('success');
    expect(result.sessionId).toBe('s1');
    expect(result.totalTokens).toBe(15);
    expect(result.costUsd).toBe(0.01);
  });

  it('enforces opts.timeoutMs and reports turn_timeout (SDK has no native timeout)', async () => {
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's1' };
        await new Promise((_resolve, reject) => {
          const sig = options.abortController.signal;
          if (sig.aborted) reject(new Error('aborted'));
          else sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      })(),
    );
    const { result } = await drain({ ...base, timeoutMs: 30 });
    expect(result.status).toBe('error_execution');
    expect(result.errorCategory).toBe('turn_timeout');
    expect(result.error).toContain('timeout');
  });

  it('an external abort yields a failure that is NOT tagged turn_timeout', async () => {
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's1' };
        await new Promise((_resolve, reject) => {
          const sig = options.abortController.signal;
          if (sig.aborted) reject(new Error('aborted'));
          else sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      })(),
    );
    const ext = new AbortController();
    ext.abort();
    const { result } = await drain({ ...base, signal: ext.signal });
    expect(result.status).toBe('error_execution');
    expect(result.errorCategory).toBe('response_error');
  });

  it('categorizes a missing/unstartable claude as agent_not_found', async () => {
    queryMock.mockImplementation(() =>
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error('spawn claude ENOENT');
      })(),
    );
    const { result } = await drain(base);
    expect(result.status).toBe('error_execution');
    expect(result.errorCategory).toBe('agent_not_found');
  });

  it('maps a denied AskUserQuestion to a blocked result + input_required', async () => {
    queryMock.mockImplementation(
      ({
        options,
      }: {
        options: {
          canUseTool: (n: string, i: unknown, e: unknown) => Promise<{ behavior: string }>;
        };
      }) =>
        (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's1' };
          const decision = await options.canUseTool('AskUserQuestion', {}, {});
          expect(decision.behavior).toBe('deny');
          yield { type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0 };
        })(),
    );
    const { events, result } = await drain(base);
    expect(result.status).toBe('blocked');
    expect(events.some((e) => e.type === 'input_required')).toBe(true);
  });

  it('layers the claude_code preset with our append + wires effort/thinking', async () => {
    queryMock.mockImplementation(() => fromArray(SUCCESS));
    await drain({
      ...base,
      systemPrompt: 'OPERATING CONTRACT',
      effort: 'high',
      thinking: 'adaptive',
    });
    const options = queryMock.mock.calls.at(-1)![0].options;
    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'OPERATING CONTRACT',
    });
    expect(options.effort).toBe('high');
    expect(options.thinking).toEqual({ type: 'adaptive' });
  });

  it('defaults to the bare claude_code preset when no systemPrompt is given', async () => {
    queryMock.mockImplementation(() => fromArray(SUCCESS));
    await drain(base);
    const options = queryMock.mock.calls.at(-1)![0].options;
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(options.effort).toBeUndefined();
    expect(options.thinking).toBeUndefined();
  });
});
