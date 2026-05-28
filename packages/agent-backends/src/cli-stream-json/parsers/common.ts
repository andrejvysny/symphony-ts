import type { ErrorCategory } from '@symphony/shared';
import { nowIso, type AgentEvent, type AgentRunStatus, type RunResult } from '../../backend.js';

export interface ParseCtx {
  sessionId?: string;
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

/**
 * Build a RunResult from the collected normalized events + process exit code.
 * Shared across CLI backends: the parsers already normalized native signals.
 */
export function resultFromEvents(
  events: AgentEvent[],
  exitCode: number,
  sessionId?: string,
): RunResult {
  let status: AgentRunStatus | undefined;
  let error: string | undefined;
  let category: ErrorCategory | undefined;
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

  if (status === undefined) {
    status = exitCode === 0 ? 'success' : 'error_execution';
    if (exitCode !== 0) {
      error = `agent exited with code ${exitCode}`;
      category = 'process_exit';
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
  };
}
