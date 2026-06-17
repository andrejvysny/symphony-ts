import type {
  AgentEvent,
  CodingAgentBackend,
  RunOptions,
  RunResult,
} from '@symphony/agent-backends';
import type { ErrorCategory, NormalizedIssue } from '@symphony/shared';
import type { SymphonyConfig } from './config/resolve.js';
import { parseConfig, resolveConfig } from './config/resolve.js';
import type { IWorkspaceManager, Workspace } from './workspace/manager.js';

export function makeIssue(partial: Partial<NormalizedIssue> & { id: string }): NormalizedIssue {
  return {
    id: partial.id,
    identifier: partial.identifier ?? partial.id.toUpperCase(),
    title: partial.title ?? `Issue ${partial.id}`,
    description: partial.description ?? null,
    priority: partial.priority ?? null,
    state: partial.state ?? 'Todo',
    branchName: partial.branchName ?? null,
    url: partial.url ?? null,
    labels: partial.labels ?? [],
    blockedBy: partial.blockedBy ?? [],
    createdAt: partial.createdAt ?? null,
    updatedAt: partial.updatedAt ?? null,
  };
}

export function testConfig(overrides: Record<string, unknown> = {}): SymphonyConfig {
  const raw = {
    tracker: { kind: 'memory', ...((overrides['tracker'] as object) ?? {}) },
    workspace: {
      repo: '/tmp/fake-repo',
      root: '/tmp/fake-ws',
      ...((overrides['workspace'] as object) ?? {}),
    },
    agent: {
      stall_timeout_ms: 0,
      persist_run_log: false,
      ...((overrides['agent'] as object) ?? {}),
    },
    polling: { interval_ms: 1000, ...((overrides['polling'] as object) ?? {}) },
  };
  return resolveConfig(parseConfig(raw), '/tmp');
}

/** A workspace manager that does no git/fs work — for orchestrator tests. */
export class FakeWorkspaceManager implements IWorkspaceManager {
  readonly created: string[] = [];
  readonly cleaned: string[] = [];

  async createForIssue(issue: NormalizedIssue): Promise<Workspace> {
    this.created.push(issue.id);
    return {
      path: `/tmp/fake-ws/${issue.identifier}`,
      branch: `symphony/${issue.identifier}`,
      created: true,
    };
  }
  async runBeforeRun() {
    return { ran: false, ok: true } as const;
  }
  async runAfterRun() {
    return { ran: false, ok: true } as const;
  }
  async cleanup(issue: NormalizedIssue): Promise<void> {
    this.cleaned.push(issue.id);
  }
}

export type ScriptedTurn =
  | { status: 'success'; tokens?: { input: number; output: number } }
  | { status: 'blocked'; reason?: string }
  | {
      status: 'error_execution' | 'error_max_turns' | 'error_budget';
      error?: string;
      category?: ErrorCategory;
      retryable?: boolean;
      /** Emit a tool_use before failing, so the run registers a side-effect (gates resume-on-failure). */
      sideEffect?: boolean;
    };

/**
 * Backend that returns scripted outcomes. `script` is consumed per run() call
 * (i.e. per worker turn). When exhausted, the last entry repeats.
 */
export class MockBackend implements CodingAgentBackend {
  readonly kind = 'mock';
  readonly calls: RunOptions[] = [];
  private idx = 0;

  constructor(private readonly script: ScriptedTurn[] = [{ status: 'success' }]) {}

  async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    this.calls.push(opts);
    const turn = this.script[Math.min(this.idx, this.script.length - 1)] ?? { status: 'success' };
    this.idx += 1;
    const sessionId = opts.resumeSessionId ?? 'sess-1';
    const at = new Date(0).toISOString();
    yield { type: 'session_started', sessionId, at };

    const input = turn.status === 'success' ? (turn.tokens?.input ?? 10) : 0;
    const output = turn.status === 'success' ? (turn.tokens?.output ?? 5) : 0;
    yield {
      type: 'usage',
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      absolute: true,
      at,
    };

    let result: RunResult;
    if (turn.status === 'success') {
      result = {
        status: 'success',
        sessionId,
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      };
      yield { type: 'turn_completed', at };
    } else if (turn.status === 'blocked') {
      result = {
        status: 'blocked',
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        error: turn.reason ?? 'blocked',
      };
      yield { type: 'input_required', reason: turn.reason ?? 'blocked', at };
    } else {
      if (turn.sideEffect) {
        yield { type: 'tool_use', toolName: 'Edit', toolUseId: 't1', input: {}, at };
      }
      result = {
        status: turn.status,
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        error: turn.error ?? turn.status,
        ...(turn.category !== undefined ? { errorCategory: turn.category } : {}),
        ...(turn.retryable !== undefined ? { retryable: turn.retryable } : {}),
      };
      yield {
        type: 'turn_failed',
        error: turn.error ?? turn.status,
        ...(turn.category !== undefined ? { category: turn.category } : {}),
        at,
      };
    }
    yield { type: 'result', result, at };
    return result;
  }
}

/** Backend whose single turn blocks until `release()` is called (concurrency/stall tests). */
export class GatedBackend implements CodingAgentBackend {
  readonly kind = 'gated';
  running = 0;
  private releasers: Array<() => void> = [];

  releaseAll(): void {
    const rs = this.releasers;
    this.releasers = [];
    for (const r of rs) r();
  }

  async *run(_opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const at = new Date(0).toISOString();
    this.running += 1;
    yield { type: 'session_started', sessionId: 'g', at };
    try {
      await new Promise<void>((resolve) => {
        if (_opts.signal?.aborted) return resolve();
        _opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        this.releasers.push(resolve);
      });
    } finally {
      this.running -= 1;
    }
    const result: RunResult = {
      status: 'success',
      sessionId: 'g',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    yield { type: 'turn_completed', at };
    yield { type: 'result', result, at };
    return result;
  }
}
