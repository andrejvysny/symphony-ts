import type { RawPlaneIssue } from '../plane/normalize.js';
import type { ToolResult } from './plane-rest.js';

/**
 * Minimal Plane REST surface the semantic tracker tools need; {@link PlaneClient} satisfies it.
 * Kept narrow so tests can pass a fake without a real transport.
 */
export interface SemanticPlaneClient {
  request<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
  getAllPages<T = unknown>(path: string): Promise<T[]>;
}

/** A tool executor: validated input → `{ success, output }` (output is a JSON string). */
export type TrackerExecutor = (input: unknown) => Promise<ToolResult>;

/** The three purpose-built tracker tools the agent uses to drive an issue's lifecycle. */
export interface PlaneSemanticTools {
  getTask: TrackerExecutor;
  updateStatus: TrackerExecutor;
  addComment: TrackerExecutor;
}

/* Rich, agent-facing tool descriptions (what / when / when-not / what it does NOT do). Shared by
 * the in-process SDK MCP server and the standalone stdio MCP server so both stay identical. */
export const TRACKER_GET_TASK_DESCRIPTION =
  'Read the full current state of one Plane issue by id: its title, description, current workflow ' +
  'status, and existing comments. Use it first, before any update, to ground yourself in the ' +
  "issue's live state. It only reads — it does not modify the issue, and it does not return other " +
  'issues or attachments.';

export const TRACKER_UPDATE_STATUS_DESCRIPTION =
  "Set one Plane issue's workflow status by id. Use it after reading the issue, and only when the " +
  "target status differs from the current one; the status name is resolved to Plane's internal id " +
  'for you. It does not post a comment or change the description.';

export const TRACKER_ADD_COMMENT_DESCRIPTION =
  'Post one comment to a Plane issue by id. Use it to record your plan on pickup and your ' +
  'evidence-backed summary on completion (what changed, the verification commands you ran and ' +
  'their result, and the commit SHA). It does not change the status.';

/** Safe issue id: letters/digits with `-`/`_`; rejects slashes, dots, and encoded separators
 * so an agent-supplied `task_id` can never escape the `/work-items/{id}/` path. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface RawState {
  id: string;
  name?: string;
}
interface RawComment {
  created_at?: string;
  comment_stripped?: string | null;
  comment_html?: string | null;
}

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

/** Strip HTML tags to plain text + decode common entities (Plane comments/descriptions are HTML). */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape a plain string and wrap it as one Plane comment HTML paragraph (already-HTML passes through). */
function toHtml(text: string): string {
  if (/^\s*</.test(text)) return text;
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc}</p>`;
}

/**
 * Build the three semantic tracker executors over a Plane REST client. They hide Plane's
 * REST/UUID mechanics: `updateStatus` resolves a status NAME to its state id, and every executor
 * validates `task_id` and returns instructive error strings the model can recover from.
 */
export function makePlaneSemanticTools(client: SemanticPlaneClient): PlaneSemanticTools {
  const getTask: TrackerExecutor = async (input) => {
    const taskId = asObject(input)['task_id'];
    if (typeof taskId !== 'string' || !ID_RE.test(taskId))
      return fail('task_id must be a valid issue id (letters, digits, "-", "_")');
    try {
      const raw = await client.request<RawPlaneIssue | null>('GET', `/work-items/${taskId}/`);
      if (!raw || typeof raw.id !== 'string')
        return fail(`issue ${taskId} was not found in this project`);
      const [states, comments] = await Promise.all([
        client.getAllPages<RawState>('/states/'),
        client.getAllPages<RawComment>(`/work-items/${taskId}/comments/`),
      ]);
      const status = raw.state ? (states.find((s) => s.id === raw.state)?.name ?? '') : '';
      const description =
        raw.description_stripped ??
        (raw.description_html ? stripHtml(raw.description_html) : (raw.description ?? null));
      return ok({
        id: raw.id,
        title: raw.name ?? '',
        description,
        status,
        comments: comments.map((c) => ({
          at: c.created_at ?? '',
          body: c.comment_stripped ?? stripHtml(c.comment_html ?? ''),
        })),
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
    try {
      const states = await client.getAllPages<RawState>('/states/');
      const match = states.find((s) => (s.name ?? '') === status);
      if (!match) {
        const names = states
          .map((s) => s.name ?? '')
          .filter((n) => n.length > 0)
          .join(', ');
        return fail(`status "${status}" was not found in this project; available states: ${names}`);
      }
      await client.request('PATCH', `/work-items/${taskId}/`, { state: match.id });
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
      await client.request('POST', `/work-items/${taskId}/comments/`, {
        comment_html: toHtml(body),
      });
      return ok({ task_id: taskId, posted: true });
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  return { getTask, updateStatus, addComment };
}
