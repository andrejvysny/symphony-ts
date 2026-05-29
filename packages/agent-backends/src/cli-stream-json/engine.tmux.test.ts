import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, RunOptions } from '../backend.js';
import type { AgentDef } from './agent-defs.js';
import { runAgentDef } from './engine.js';
import { parseClaudeStreamJson } from './parsers/claude-stream-json.js';
import { tmuxAvailable, type TmuxController } from './tmux.js';

const LINES = [
  { type: 'system', subtype: 'init', session_id: 'sess-tmux' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
  {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 100, output_tokens: 25 },
    total_cost_usd: 0.05,
  },
];

const fakeDef: AgentDef = {
  kind: 'claude-cli',
  binary: process.execPath,
  promptViaStdin: false,
  buildArgs: () => ['-e', 'process.exit(0)'],
  parser: parseClaudeStreamJson,
};

async function drain(
  gen: AsyncGenerator<AgentEvent, unknown, void>,
): Promise<{ events: AgentEvent[]; result: unknown }> {
  const events: AgentEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe('runAgentDef (tmux path, fake controller)', () => {
  it('emits process_started, parses the raw log, and cleans up the session', async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), 'tmux-fake-'));
    const killed: string[] = [];
    const fake: TmuxController = {
      // simulate the agent: write raw stdout to run.jsonl + record its exit code
      async newSession() {
        await writeFile(
          path.join(logDir, 'run.jsonl'),
          LINES.map((l) => JSON.stringify(l)).join('\n') + '\n',
        );
        await writeFile(path.join(logDir, 'exit.code'), '0\n');
      },
      async panePid() {
        return 4242;
      },
      async hasSession() {
        return false; // already finished
      },
      async killSession(name) {
        killed.push(name);
      },
    };
    const opts: RunOptions = {
      prompt: 'x',
      cwd: process.cwd(),
      tmux: { sessionName: 'symphony-T-1', logDir },
    };

    const { events, result } = await drain(runAgentDef(fakeDef, opts, fake));

    const proc = events.find((e) => e.type === 'process_started');
    expect(proc).toMatchObject({ tmuxSession: 'symphony-T-1', pid: 4242 });
    expect(events.map((e) => e.type)).toContain('text_delta');
    expect(result).toMatchObject({ status: 'success', sessionId: 'sess-tmux', totalTokens: 125 });
    expect(killed).toContain('symphony-T-1');
  });

  it('kills the session when the run is aborted', async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), 'tmux-abort-'));
    const killed: string[] = [];
    const fake: TmuxController = {
      async newSession() {},
      async panePid() {
        return null;
      },
      async hasSession() {
        return false;
      },
      async killSession(name) {
        killed.push(name);
      },
    };
    const ac = new AbortController();
    ac.abort();
    const opts: RunOptions = {
      prompt: 'x',
      cwd: process.cwd(),
      signal: ac.signal,
      tmux: { sessionName: 'symphony-A-1', logDir },
    };

    const { events } = await drain(runAgentDef(fakeDef, opts, fake));
    // panePid null → process_started carries no pid
    expect(events.find((e) => e.type === 'process_started')).toMatchObject({
      tmuxSession: 'symphony-A-1',
    });
    expect(killed).toContain('symphony-A-1');
  });
});

// Opt-in: only runs where a real `tmux` binary is present (skipped in bare CI).
const HAS_TMUX = await tmuxAvailable();

describe.skipIf(!HAS_TMUX)('runAgentDef (real tmux)', () => {
  afterEach(() => vi.setConfig({ testTimeout: 5_000 }));

  it('runs a real session, writes the log, and parses events', async () => {
    vi.setConfig({ testTimeout: 20_000 });
    const logDir = await mkdtemp(path.join(os.tmpdir(), 'tmux-real-'));
    const script = LINES.map(
      (l) => `process.stdout.write(${JSON.stringify(JSON.stringify(l))} + '\\n')`,
    ).join(';');
    const def: AgentDef = { ...fakeDef, buildArgs: () => ['-e', script] };
    const opts: RunOptions = {
      prompt: 'x',
      cwd: process.cwd(),
      tmux: { sessionName: `symphony-real-${process.pid}`, logDir },
    };

    const { events, result } = await drain(runAgentDef(def, opts));

    expect(events.find((e) => e.type === 'process_started')).toBeTruthy();
    expect(events.map((e) => e.type)).toContain('text_delta');
    expect(result).toMatchObject({ status: 'success', totalTokens: 125 });
  });
});
