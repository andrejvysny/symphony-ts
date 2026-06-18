import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  supportsActivity,
  supportsBoard,
  supportsIssueCreation,
  supportsIssueWriter,
} from '../tracker.js';
import { FileTracker, type FileTrackerOptions, seedStates } from './adapter.js';

describe('seedStates', () => {
  it('orders active → review → terminal with inferred types and no dupes', () => {
    const states = seedStates(['Todo', 'In Progress'], 'Human Review', ['Done', 'Cancelled']);
    expect(states.map((s) => s.name)).toEqual([
      'Todo',
      'In Progress',
      'Human Review',
      'Done',
      'Cancelled',
    ]);
    expect(states.find((s) => s.name === 'Todo')?.type).toBe('unstarted');
    expect(states.find((s) => s.name === 'In Progress')?.type).toBe('started');
    expect(states.find((s) => s.name === 'Human Review')?.type).toBe('started');
    expect(states.find((s) => s.name === 'Done')?.type).toBe('completed');
    expect(states.find((s) => s.name === 'Cancelled')?.type).toBe('canceled');
    expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('dedupes a state listed twice', () => {
    expect(seedStates(['Todo'], 'Todo', ['Todo']).map((s) => s.name)).toEqual(['Todo']);
  });
});

describe('FileTracker', () => {
  let root: string;
  const make = (extra: Partial<FileTrackerOptions> = {}): FileTracker =>
    new FileTracker({
      dataRoot: root,
      projectKey: 'demo',
      identifier: 'SYM',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Cancelled'],
      reviewState: 'Human Review',
      ...extra,
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ft-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('advertises the full capability surface', () => {
    const t = make();
    expect(supportsIssueCreation(t)).toBe(true);
    expect(supportsBoard(t)).toBe(true);
    expect(supportsIssueWriter(t)).toBe(true);
    expect(supportsActivity(t)).toBe(true);
    expect(t.kind).toBe('file');
  });

  it('creates issues with prefixed ids, embedded attachments, and real timestamps', async () => {
    const t = make();
    const issue = await t.createIssue({
      title: 'X',
      description: 'do it',
      attachments: [{ url: '/api/v1/uploads/demo/u/a.txt', title: 'a.txt' }],
    });
    expect(issue.id).toBe('SYM-1');
    expect(issue.identifier).toBe('SYM-1');
    expect(issue.description).toContain('![a.txt](/api/v1/uploads/demo/u/a.txt)');
    expect(issue.priority).toBeNull();
    expect(issue.branchName).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(Date.parse(issue.createdAt ?? '')).toBeGreaterThan(0);
  });

  it('persists the sequence counter across instances', async () => {
    expect((await make().createIssue({ title: 'a' })).id).toBe('SYM-1');
    expect((await make().createIssue({ title: 'b' })).id).toBe('SYM-2');
  });

  it('mints distinct ids for concurrent creates', async () => {
    const t = make();
    const issues = await Promise.all(
      Array.from({ length: 15 }, (_, i) => t.createIssue({ title: `t${i}` })),
    );
    expect(new Set(issues.map((i) => i.id)).size).toBe(15);
  });

  it('filters candidates by active state and fetches by states / ids', async () => {
    const t = make();
    const a = await t.createIssue({ title: 'a', stateName: 'Todo' });
    const b = await t.createIssue({ title: 'b', stateName: 'Done' });
    expect((await t.fetchCandidateIssues()).map((i) => i.id)).toEqual([a.id]);
    expect((await t.fetchIssuesByStates(['Done'])).map((i) => i.id)).toEqual([b.id]);
    const refs = await t.fetchIssueStatesByIds([a.id, 'missing']);
    expect(refs).toEqual([{ id: a.id, identifier: a.id, state: 'Todo' }]);
  });

  it('moves state, records activity, and throws on a missing issue', async () => {
    const t = make();
    const issue = await t.createIssue({ title: 'x', stateName: 'Todo' });
    await t.updateIssueState(issue.id, 'In Progress');
    expect((await t.fetchIssueStatesByIds([issue.id]))[0]?.state).toBe('In Progress');
    const activity = await t.fetchActivity(issue.id);
    expect(activity.some((a) => a.field === 'state' && a.newValue === 'In Progress')).toBe(true);
    expect(activity.some((a) => a.verb === 'created')).toBe(true);
    await expect(t.updateIssueState('nope', 'Done')).rejects.toThrow(/not found/);
  });

  it('edits issue metadata and records per-field activity', async () => {
    const t = make();
    const issue = await t.createIssue({ title: 'old', stateName: 'Todo' });
    await t.updateIssue(issue.id, { title: 'new', priority: 2, labelIds: ['bug'] });
    const [fresh] = await t.fetchAllIssues();
    expect(fresh?.title).toBe('new');
    expect(fresh?.priority).toBe(2);
    expect(fresh?.labels).toEqual(['bug']);
    const fields = (await t.fetchActivity(issue.id)).map((a) => a.field);
    expect(fields).toContain('title');
    expect(fields).toContain('priority');
    expect(fields).toContain('labels');
  });

  it('records comments and attachments', async () => {
    const t = make();
    const issue = await t.createIssue({ title: 'x' });
    await t.addComment(issue.id, 'a note');
    expect((await t.fetchComments(issue.id)).map((c) => c.body)).toEqual(['a note']);
    const up = await t.uploadFile({
      filename: 'b.png',
      contentType: 'image/png',
      data: Buffer.from('x'),
    });
    expect(up.assetUrl).toContain('/api/v1/uploads/demo/');
    await t.attachToIssue(issue.id, up.assetUrl, 'b.png');
    const stored = await t.store.readIssue(issue.id);
    expect(stored?.attachments?.[0]).toEqual({ url: up.assetUrl, title: 'b.png' });
  });

  it('lists workflow states from the seed and labels from seed + issues', async () => {
    const t = make();
    expect((await t.listWorkflowStates()).map((s) => s.name)).toEqual([
      'Todo',
      'In Progress',
      'Human Review',
      'Done',
      'Cancelled',
    ]);
    const issue = await t.createIssue({ title: 'x' });
    await t.updateIssue(issue.id, { labelIds: ['bug', 'ui'] });
    expect((await t.listLabels()).map((l) => l.name).sort()).toEqual(['bug', 'ui']);
  });
});
