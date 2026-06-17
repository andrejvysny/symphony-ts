import type { IssueWriter } from '../tracker.js';

/** Result shape shared with the SDK MCP tool wrapper (mirrors linear-graphql ToolResult). */
export interface MemoryToolResult {
  success: boolean;
  output: string;
}

/** Minimal write surface the offline tools need; MemoryTracker satisfies it. */
export type MemoryWriter = Pick<IssueWriter, 'updateIssueState' | 'addComment'>;

function asObject(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/**
 * Executor for an offline `set_issue_state` tool. Gives a real coding agent a way to park
 * its MemoryTracker ticket in the no-Linear dry-run — the offline parallel to the live
 * `linear_graphql` state move. Input: `{ issueId, state }` (issueId === issue.id).
 */
export function makeSetIssueStateExecutor(
  writer: MemoryWriter,
): (input: unknown) => Promise<MemoryToolResult> {
  return async (input) => {
    const obj = asObject(input);
    const issueId = obj?.['issueId'];
    const state = obj?.['state'];
    if (typeof issueId !== 'string' || issueId.length === 0)
      return {
        success: false,
        output: JSON.stringify({ error: 'issueId must be a non-empty string' }),
      };
    if (typeof state !== 'string' || state.length === 0)
      return {
        success: false,
        output: JSON.stringify({ error: 'state must be a non-empty string' }),
      };
    try {
      await writer.updateIssueState(issueId, state);
      return { success: true, output: JSON.stringify({ ok: true, issueId, state }) };
    } catch (e) {
      return { success: false, output: JSON.stringify({ error: (e as Error).message }) };
    }
  };
}

/** Executor for an offline `add_comment` tool. Input: `{ issueId, body }`. */
export function makeAddCommentExecutor(
  writer: MemoryWriter,
): (input: unknown) => Promise<MemoryToolResult> {
  return async (input) => {
    const obj = asObject(input);
    const issueId = obj?.['issueId'];
    const body = obj?.['body'];
    if (typeof issueId !== 'string' || issueId.length === 0)
      return {
        success: false,
        output: JSON.stringify({ error: 'issueId must be a non-empty string' }),
      };
    if (typeof body !== 'string')
      return { success: false, output: JSON.stringify({ error: 'body must be a string' }) };
    try {
      await writer.addComment(issueId, body);
      return { success: true, output: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { success: false, output: JSON.stringify({ error: (e as Error).message }) };
    }
  };
}
