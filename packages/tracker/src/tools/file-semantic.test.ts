import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTracker } from '../file/adapter.js';
import { type FileSemanticTarget, makeFileSemanticTools } from './file-semantic.js';

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe('makeFileSemanticTools', () => {
  let root: string;
  let tracker: FileTracker;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-fsem-'));
    tracker = new FileTracker({
      dataRoot: root,
      projectKey: 'demo',
      identifier: 'SYM',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
      reviewState: 'Human Review',
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const allowed = ['Todo', 'In Progress', 'Human Review'];

  it('getTask rejects a bad id and reports a missing issue', async () => {
    const { getTask } = makeFileSemanticTools(tracker, allowed);
    expect((await getTask({ task_id: 'bad/id' })).success).toBe(false);
    const missing = await getTask({ task_id: 'SYM-99' });
    expect(missing.success).toBe(false);
    expect(parse(missing.output)['error'] as string).toMatch(/not found/);
  });

  it('getTask returns the issue with its comments in wire shape', async () => {
    const issue = await tracker.createIssue({ title: 'T', description: 'desc', stateName: 'Todo' });
    await tracker.addComment(issue.id, 'hello');
    const { getTask } = makeFileSemanticTools(tracker, allowed);
    const r = await getTask({ task_id: issue.id });
    expect(r.success).toBe(true);
    const data = parse(r.output)['data'] as Record<string, unknown>;
    expect(data).toMatchObject({ id: issue.id, title: 'T', description: 'desc', status: 'Todo' });
    expect(data['comments']).toEqual([{ at: expect.any(String), body: 'hello' }]);
  });

  it('updateStatus validates id, status, and allowedStates; is idempotent', async () => {
    const issue = await tracker.createIssue({ title: 'T', stateName: 'Todo' });
    const { updateStatus } = makeFileSemanticTools(tracker, allowed);
    expect((await updateStatus({ task_id: issue.id, status: '' })).success).toBe(false);
    expect((await updateStatus({ task_id: issue.id, status: 'Done' })).success).toBe(false); // terminal not settable
    const moved = await updateStatus({ task_id: issue.id, status: 'In Progress' });
    expect(moved.success).toBe(true);
    expect((await tracker.fetchIssueStatesByIds([issue.id]))[0]?.state).toBe('In Progress');
    // idempotent: same status again succeeds without error
    expect((await updateStatus({ task_id: issue.id, status: 'In Progress' })).success).toBe(true);
  });

  it('addComment validates body + existence and posts', async () => {
    const issue = await tracker.createIssue({ title: 'T' });
    const { addComment } = makeFileSemanticTools(tracker, allowed);
    expect((await addComment({ task_id: issue.id, body: '   ' })).success).toBe(false);
    expect((await addComment({ task_id: 'SYM-99', body: 'x' })).success).toBe(false);
    const r = await addComment({ task_id: issue.id, body: 'done' });
    expect(parse(r.output)['data']).toEqual({ task_id: issue.id, posted: true });
    expect((await tracker.fetchComments(issue.id)).map((c) => c.body)).toContain('done');
  });

  it('surfaces a thrown target error as a failed ToolResult', async () => {
    const boom: FileSemanticTarget = {
      getIssue: () => Promise.reject(new Error('disk gone')),
      fetchComments: () => Promise.resolve([]),
      updateIssueState: () => Promise.resolve(),
      addComment: () => Promise.resolve(),
    };
    const { getTask } = makeFileSemanticTools(boom, allowed);
    const r = await getTask({ task_id: 'SYM-1' });
    expect(r.success).toBe(false);
    expect(parse(r.output)['error']).toBe('disk gone');
  });
});
