import { describe, expect, it } from 'vitest';
import type { AgentEvent, RunOptions } from '../backend.js';
import type { AgentDef } from './agent-defs.js';
import { runAgentDef } from './engine.js';
import { parseClaudeStreamJson } from './parsers/claude-stream-json.js';

// A node script that emits canned claude stream-json on stdout.
const SCRIPT = `
const lines = [
  { type: 'system', subtype: 'init', session_id: 'sess-xyz' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
  { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 25 }, total_cost_usd: 0.05 },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + '\\n');
`;

const fakeDef: AgentDef = {
  kind: 'claude-cli',
  binary: process.execPath, // node
  promptViaStdin: false,
  buildArgs: () => ['-e', SCRIPT],
  parser: parseClaudeStreamJson,
};

const opts: RunOptions = { prompt: 'x', cwd: process.cwd() };

describe('runAgentDef (real subprocess)', () => {
  it('streams normalized events and synthesizes a success RunResult', async () => {
    const events: AgentEvent[] = [];
    const gen = runAgentDef(fakeDef, opts);
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain('session_started');
    expect(types).toContain('text_delta');
    expect(types).toContain('turn_completed');
    expect(result!.status).toBe('success');
    expect(result!.sessionId).toBe('sess-xyz');
    expect(result!.totalTokens).toBe(125);
    expect(result!.costUsd).toBe(0.05);
  });

  it('reports error_execution when the process exits non-zero with no result', async () => {
    const def: AgentDef = {
      ...fakeDef,
      buildArgs: () => ['-e', 'process.exit(3)'],
    };
    const gen = runAgentDef(def, opts);
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    expect(result!.status).toBe('error_execution');
  });

  it('aborts a silent run via the idle watchdog (R3)', async () => {
    // A process that lives but emits nothing → the idle watchdog should kill it.
    const def: AgentDef = { ...fakeDef, buildArgs: () => ['-e', 'setTimeout(() => {}, 100000)'] };
    const gen = runAgentDef(def, { prompt: 'x', cwd: process.cwd(), idleTimeoutMs: 200 });
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    expect(result!.status).toBe('error_execution');
    expect(result!.errorCategory).toBe('idle_timeout');
    expect(result!.retryable).toBe(true);
  });

  it('does NOT trip the idle watchdog when the stream keeps emitting (R3)', async () => {
    // Emits a line every 60ms for ~5 lines, then a success result — under a 250ms idle budget each
    // line resets the timer, so the run completes normally.
    const script = `
      let n = 0;
      const t = setInterval(() => {
        process.stdout.write(JSON.stringify({ type: 'system', subtype: 'status', status: 'working' }) + '\\n');
        if (++n >= 5) {
          clearInterval(t);
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
        }
      }, 60);
    `;
    const def: AgentDef = { ...fakeDef, buildArgs: () => ['-e', script] };
    const gen = runAgentDef(def, { prompt: 'x', cwd: process.cwd(), idleTimeoutMs: 250 });
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    expect(result!.status).toBe('success');
  });

  it('enforces the cost budget → error_budget (P1)', async () => {
    const def: AgentDef = {
      ...fakeDef,
      buildArgs: () => [
        '-e',
        `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 5 }) + '\\n')`,
      ],
    };
    const gen = runAgentDef(def, { prompt: 'x', cwd: process.cwd(), maxBudgetUsd: 1 });
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    expect(result!.status).toBe('error_budget');
    expect(result!.retryable).toBe(false);
  });

  it('surfaces non-JSON stdout lines instead of silently dropping them (O2)', async () => {
    const def: AgentDef = {
      ...fakeDef,
      buildArgs: () => ['-e', `process.stdout.write('this is not json\\n'); process.exit(2)`],
    };
    const gen = runAgentDef(def, opts);
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    expect(result!.status).toBe('error_execution');
    expect(result!.error).toContain('this is not json');
  });
});
