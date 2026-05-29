import { describe, expect, it } from 'vitest';
import { MemoryTracker } from './memory-tracker.js';
import { supportsBoard, supportsIssueWriter } from '../tracker.js';

describe('MemoryTracker board + writer parity', () => {
  it('implements the board + writer capability guards', () => {
    const t = new MemoryTracker();
    expect(supportsBoard(t)).toBe(true);
    expect(supportsIssueWriter(t)).toBe(true);
  });

  it('synthesizes workflow states from active + terminal states', async () => {
    const t = new MemoryTracker({
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Canceled'],
    });
    const states = await t.listWorkflowStates();
    expect(states.map((s) => s.name)).toEqual(['Todo', 'In Progress', 'Done', 'Canceled']);
    expect(states.find((s) => s.name === 'Todo')?.type).toBe('unstarted');
    expect(states.find((s) => s.name === 'Canceled')?.type).toBe('canceled');
  });

  it('creates with attachments, lists all, moves state, and records comments/attachments', async () => {
    const t = new MemoryTracker({
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
    });
    const issue = await t.createIssue({
      title: 'X',
      description: 'do it',
      attachments: [{ url: 'memory://asset/a.txt', title: 'a.txt' }],
    });
    expect(issue.description).toContain('![a.txt](memory://asset/a.txt)');

    const all = await t.fetchAllIssues();
    expect(all.map((i) => i.id)).toContain(issue.id);

    await t.updateIssueState(issue.id, 'In Progress');
    expect((await t.fetchIssueStatesByIds([issue.id]))[0]?.state).toBe('In Progress');

    await t.addComment(issue.id, 'a note');
    const up = await t.uploadFile({
      filename: 'b.png',
      contentType: 'image/png',
      data: Buffer.from('x'),
    });
    await t.attachToIssue(issue.id, up.assetUrl, 'b.png');
    expect(t.comments).toContainEqual({ issueId: issue.id, body: 'a note' });
    expect(t.attachments[0]?.url).toBe(up.assetUrl);
  });
});
