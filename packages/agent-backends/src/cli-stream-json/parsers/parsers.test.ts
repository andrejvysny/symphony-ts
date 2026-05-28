import { describe, expect, it } from 'vitest';
import { parseClaudeStreamJson } from './claude-stream-json.js';
import { parseCodexJsonl } from './codex-jsonl.js';
import { parseOpencodeJsonl } from './opencode-jsonl.js';
import type { ParseCtx } from './common.js';

describe('parseClaudeStreamJson', () => {
  it('maps init, assistant text/tool, and success result', () => {
    const ctx: ParseCtx = {};
    expect(
      parseClaudeStreamJson({ type: 'system', subtype: 'init', session_id: 's1' }, ctx)[0],
    ).toMatchObject({
      type: 'session_started',
      sessionId: 's1',
    });
    const a = parseClaudeStreamJson(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      },
      ctx,
    );
    expect(a.map((e) => e.type)).toEqual(['text_delta', 'tool_use']);
    const r = parseClaudeStreamJson(
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 10, output_tokens: 4 },
        total_cost_usd: 0.01,
      },
      ctx,
    );
    expect(r.map((e) => e.type)).toEqual(['usage', 'turn_completed']);
  });

  it('maps error result to turn_failed', () => {
    const r = parseClaudeStreamJson({ type: 'result', subtype: 'error_max_turns', usage: {} }, {});
    expect(r.some((e) => e.type === 'turn_failed')).toBe(true);
  });
});

describe('parseCodexJsonl', () => {
  it('maps thread.started + turn.completed', () => {
    const ctx: ParseCtx = {};
    expect(parseCodexJsonl({ type: 'thread.started', thread_id: 'th1' }, ctx)[0]).toMatchObject({
      type: 'session_started',
      sessionId: 'th1',
    });
    const c = parseCodexJsonl(
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
      ctx,
    );
    expect(c.map((e) => e.type)).toEqual(['usage', 'turn_completed']);
  });
  it('maps elicitation errors to input_required', () => {
    const e = parseCodexJsonl(
      { type: 'turn.failed', error: { message: 'elicitation required' } },
      {},
    );
    expect(e[0]).toMatchObject({ type: 'input_required' });
  });
});

describe('parseOpencodeJsonl', () => {
  it('maps step_start + step_finish stop', () => {
    const ctx: ParseCtx = {};
    expect(parseOpencodeJsonl({ type: 'step_start', sessionID: 'oc1' }, ctx)[0]).toMatchObject({
      type: 'session_started',
      sessionId: 'oc1',
    });
    const f = parseOpencodeJsonl(
      { type: 'step_finish', reason: 'stop', tokens: { input: 3, output: 1 }, cost: 0.002 },
      ctx,
    );
    expect(f.map((e) => e.type)).toEqual(['usage', 'turn_completed']);
  });
});
