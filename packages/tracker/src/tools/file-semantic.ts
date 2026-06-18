import type { NormalizedIssue } from '@symphony/shared';
import type { IssueComment } from '../tracker.js';

/** A tool executor: validated input → `{ success, output }` (output is a JSON string). */
export interface ToolResult {
  success: boolean;
  output: string;
}
export type TrackerExecutor = (input: unknown) => Promise<ToolResult>;

/** The three purpose-built tracker tools the agent uses to drive an issue's lifecycle. */
export interface SemanticTools {
  getTask: TrackerExecutor;
  updateStatus: TrackerExecutor;
  addComment: TrackerExecutor;
}

/** The minimal read+write surface the semantic tools need; {@link FileTracker} satisfies it. */
export interface FileSemanticTarget {
  getIssue(id: string): Promise<NormalizedIssue | null>;
  fetchComments(id: string): Promise<IssueComment[]>;
  updateIssueState(id: string, state: string): Promise<void>;
  addComment(id: string, body: string): Promise<void>;
}

/* Agent-facing tool descriptions (what / when / what it does NOT do). Tracker-neutral so they hold
 * for any tracker backend. Shared by the in-process SDK MCP server and the stdio bridge client. */
export const TRACKER_GET_TASK_DESCRIPTION =
  'Read the full current state of one issue by id: its title, description, current workflow status, ' +
  'and existing comments. Use it first, before any update, to ground yourself in the issue’s live ' +
  'state. It only reads — it does not modify the issue, and it does not return other issues or attachments.';

export const TRACKER_UPDATE_STATUS_DESCRIPTION =
  'Set one issue’s workflow status by id. Use it after reading the issue, and only when the target ' +
  'status differs from the current one. It does not post a comment or change the description.';

export const TRACKER_ADD_COMMENT_DESCRIPTION =
  'Post one comment to an issue by id. Use it to record your plan on pickup and your evidence-backed ' +
  'summary on completion (what changed, the verification commands you ran and their result, and the ' +
  'commit SHA). It does not change the status.';

/** Safe issue id: letters/digits with `-`/`_`; rejects slashes, dots, and encoded separators. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function asObject(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
function ok(data: unknown): ToolResult {
  return { success: true, output: JSON.stringify({ data: data ?? null }) };
}
function fail(error: string): ToolResult {
  return { success: false, output: JSON.stringify({ error }) };
}

/**
 * Build the three semantic tracker executors over a local file-backed tracker. `updateStatus` is
 * validated against the agent's settable states (`allowedStates`) and is idempotent when the issue
 * is already at the target. Every executor validates `task_id` and returns instructive error
 * strings the model can recover from.
 */
export function makeFileSemanticTools(
  target: FileSemanticTarget,
  allowedStates: string[] = [],
): SemanticTools {
  const allowed = new Set(allowedStates);

  const getTask: TrackerExecutor = async (input) => {
    const taskId = asObject(input)['task_id'];
    if (typeof taskId !== 'string' || !ID_RE.test(taskId))
      return fail('task_id must be a valid issue id (letters, digits, "-", "_")');
    try {
      const issue = await target.getIssue(taskId);
      if (!issue) return fail(`issue ${taskId} was not found in this project`);
      const comments = await target.fetchComments(taskId);
      return ok({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        status: issue.state,
        comments: comments.map((c) => ({ at: c.at, body: c.body })),
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  const updateStatus: TrackerExecutor = async (input) => {
    const o = asObject(input);
    const taskId = o['task_id'];
    const status = o['status'];
    if (typeof taskId !== 'string' || !ID_RE.test(taskId))
      return fail('task_id must be a valid issue id (letters, digits, "-", "_")');
    if (typeof status !== 'string' || status.trim().length === 0)
      return fail('status must be a non-empty workflow state name');
    if (allowed.size > 0 && !allowed.has(status))
      return fail(
        `status "${status}" is not settable; available states: ${[...allowed].join(', ')}`,
      );
    try {
      const issue = await target.getIssue(taskId);
      if (!issue) return fail(`issue ${taskId} was not found in this project`);
      if (issue.state !== status) await target.updateIssueState(taskId, status);
      return ok({ task_id: taskId, status });
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  const addComment: TrackerExecutor = async (input) => {
    const o = asObject(input);
    const taskId = o['task_id'];
    const body = o['body'];
    if (typeof taskId !== 'string' || !ID_RE.test(taskId))
      return fail('task_id must be a valid issue id (letters, digits, "-", "_")');
    if (typeof body !== 'string' || body.trim().length === 0)
      return fail('body must be a non-empty string');
    try {
      const issue = await target.getIssue(taskId);
      if (!issue) return fail(`issue ${taskId} was not found in this project`);
      await target.addComment(taskId, body);
      return ok({ task_id: taskId, posted: true });
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  return { getTask, updateStatus, addComment };
}
