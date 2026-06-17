import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, CodingAgentBackend, RunResult } from '@symphony/agent-backends';
import { MemoryTracker } from '@symphony/tracker';
import { PromptBuilder } from '../prompt/builder.js';
import { FakeWorkspaceManager, makeIssue, testConfig } from '../test-support.js';
import { runWorker } from './worker.js';

// Emits a tool_use whose input embeds a secret, to verify the audit log redacts it.
const secretBackend: CodingAgentBackend = {
  kind: 'mock',
  async *run(): AsyncGenerator<AgentEvent, RunResult, void> {
    const at = new Date(0).toISOString();
    yield { type: 'session_started', sessionId: 's', at };
    yield {
      type: 'tool_use',
      toolName: 'Bash',
      toolUseId: 't1',
      input: { command: 'echo token=abc123secretvalue' },
      at,
    };
    const result: RunResult = {
      status: 'success',
      sessionId: 's',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    yield { type: 'turn_completed', at };
    yield { type: 'result', result, at };
    return result;
  },
};

describe('worker audit log (O1)', () => {
  it('writes a per-run events.jsonl and redacts secrets', async () => {
    const config = testConfig({
      agent: { persist_run_log: true, max_turns: 1, stall_timeout_ms: 0 },
    });
    const issue = makeIssue({ id: 'aud1', identifier: 'AUDIT-1', state: 'Todo' });
    const tracker = new MemoryTracker({
      issues: [issue],
      activeStates: config.tracker.active_states,
      terminalStates: config.tracker.terminal_states,
    });

    await runWorker(
      {
        tracker,
        workspaceManager: new FakeWorkspaceManager(),
        promptBuilder: new PromptBuilder('do {{ issue.identifier }}'),
        backend: secretBackend,
        config,
      },
      {
        issue,
        attempt: null,
        signal: new AbortController().signal,
        emit: () => {},
        onSession: () => {},
        onWorktree: () => {},
        onProcess: () => {},
      },
    );

    const logPath = path.join(config.logs_root, 'AUDIT-1', '1', 'events.jsonl');
    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('"type":"tool_use"');
    expect(content).toContain('token=***'); // secret masked
    expect(content).not.toContain('abc123secretvalue'); // raw secret never written
  });
});
