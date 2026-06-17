import { describe, expect, it } from 'vitest';
import { MemoryTracker } from '../memory/memory-tracker.js';
import { makeAddCommentExecutor, makeSetIssueStateExecutor } from './memory-tools.js';

function tracker(): MemoryTracker {
  return new MemoryTracker({
    issues: [
      {
        id: 'mem-1',
        identifier: 'MEM-1',
        title: 't',
        description: null,
        priority: null,
        state: 'Todo',
        branchName: null,
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
    activeStates: ['Todo'],
    terminalStates: ['Done'],
  });
}

describe('memory-tools executors', () => {
  it('set_issue_state moves the ticket (offline parity with linear_graphql)', async () => {
    const t = tracker();
    const exec = makeSetIssueStateExecutor(t);
    const res = await exec({ issueId: 'mem-1', state: 'Human Review' });
    expect(res.success).toBe(true);
    expect(t.get('mem-1')?.state).toBe('Human Review');
  });

  it('set_issue_state rejects bad input without mutating', async () => {
    const t = tracker();
    const exec = makeSetIssueStateExecutor(t);
    expect((await exec({ issueId: 'mem-1' })).success).toBe(false);
    expect((await exec({ state: 'Done' })).success).toBe(false);
    expect((await exec(null)).success).toBe(false);
    expect(t.get('mem-1')?.state).toBe('Todo');
  });

  it('set_issue_state surfaces tracker errors as a failure result', async () => {
    const t = tracker();
    const exec = makeSetIssueStateExecutor(t);
    const res = await exec({ issueId: 'nope', state: 'Done' });
    expect(res.success).toBe(false);
    expect(res.output).toContain('not found');
  });

  it('add_comment records a comment', async () => {
    const t = tracker();
    const exec = makeAddCommentExecutor(t);
    const res = await exec({ issueId: 'mem-1', body: 'done locally' });
    expect(res.success).toBe(true);
    expect(t.comments).toEqual([{ issueId: 'mem-1', body: 'done locally' }]);
  });
});
