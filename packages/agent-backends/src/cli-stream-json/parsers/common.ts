import type { ErrorCategory } from '@symphony/shared';
import { nowIso, type AgentEvent, type AgentRunStatus, type RunResult } from '../../backend.js';
import { classify } from '../../failure-classification.js';

export interface ParseCtx {
  sessionId?: string;
  /** True once the current assistant message streamed text via partial deltas (dedup guard). */
  streamedText?: boolean;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export function contentBlocks(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown })?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function at(): string {
  return nowIso();
}

/** Extra process-level signals the engine knows but the event stream doesn't carry. */
export interface ResultContext {
  /** OS signal that killed the process, if any. */
  signal?: NodeJS.Signals | string | null;
  /** Captured stderr tail — folded into error text + failure classification. */
  stderr?: string;
}

/**
 * Build a RunResult from the collected normalized events + process exit code.
 * Shared across CLI backends: the parsers already normalized native signals. Failures are run
 * through {@link classify} (using the error text, exit code, OS signal, and stderr tail) to
 * derive a precise {@link ErrorCategory} and the `retryable` bit the orchestrator gates on.
 */
export function resultFromEvents(
  events: AgentEvent[],
  exitCode: number,
  sessionId?: string,
  extra: ResultContext = {},
): RunResult {
  let status: AgentRunStatus | undefined;
  let error: string | undefined;
  let category: ErrorCategory | undefined;
  let retryable: boolean | undefined;
  let input = 0;
  let output = 0;
  let total = 0;
  let costUsd: number | undefined;

  for (const ev of events) {
    if (ev.type === 'usage') {
      if (ev.inputTokens !== undefined) input = ev.inputTokens;
      if (ev.outputTokens !== undefined) output = ev.outputTokens;
      if (ev.totalTokens !== undefined) total = ev.totalTokens;
      if (ev.costUsd !== undefined) costUsd = ev.costUsd;
    } else if (ev.type === 'input_required') {
      status = 'blocked';
      error = ev.reason;
    } else if (ev.type === 'turn_failed' && status !== 'blocked') {
      status = 'error_execution';
      error = ev.error;
      category = ev.category ?? 'turn_failed';
    } else if (ev.type === 'turn_completed' && status === undefined) {
      status = 'success';
    }
  }

  const stderr = extra.stderr?.trim();
  const signal = extra.signal ?? null;

  if (status === 'error_execution') {
    const text = [error, stderr].filter(Boolean).join('\n');
    const c = classify({ exitCode, signal, text, ...(category ? { category } : {}) });
    category = c.category;
    retryable = c.retryable;
  } else if (status === undefined) {
    if (exitCode === 0) {
      status = 'success';
    } else {
      status = 'error_execution';
      error = stderr
        ? `agent exited with code ${exitCode}: ${stderr.slice(-500)}`
        : `agent exited with code ${exitCode}`;
      const c = classify({ exitCode, signal, text: stderr ?? '' });
      category = c.category;
      retryable = c.retryable;
    }
  }
  if (total === 0) total = input + output;

  return {
    status,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(category !== undefined ? { errorCategory: category } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}
