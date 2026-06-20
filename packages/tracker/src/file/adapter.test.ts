import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  supportsActivity,
  supportsBoard,
  supportsIssueCreation,
  supportsIssueRemoval,
  supportsIssueWriter,
  supportsPlanStore,
} from '../tracker.js';
import { FileTracker, type FileTrackerOptions, seedStates } from './adapter.js';

describe('seedStates', () => {
  it('orders backlog → active → review → terminal with inferred types and no dupes', () => {
    const states = seedStates('Backlog', ['Todo', 'In Progress'], 'Human Review', [
      'Done',
      'Cancelled',
    ]);
    expect(states.map((s) => s.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'Human Review',
      'Done',
      'Cancelled',
    ]);
    expect(states.find((s) => s.name === 'Backlog')?.type).toBe('backlog');
    expect(states.find((s) => s.name === 'Todo')?.type).toBe('unstarted');
    expect(states.find((s) => s.name === 'In Progress')?.type).toBe('started');
    expect(states.find((s) => s.name === 'Human Review')?.type).toBe('started');
    expect(states.find((s) => s.name === 'Done')?.type).toBe('completed');
    expect(states.find((s) => s.name === 'Cancelled')?.type).toBe('canceled');
    expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('skips an empty/undefined backlog or review name', () => {
    expect(seedStates('', ['Todo'], undefined, ['Done']).map((s) => s.name)).toEqual([
      'Todo',
      'Done',
    ]);
  });

  it('dedupes a state listed twice', () => {
    expect(seedStates(undefined, ['Todo'], 'Todo', ['Todo']).map((s) => s.name)).toEqual(['Todo']);
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
    expect(supportsPlanStore(t)).toBe(true);
    expect(t.kind).toBe('file');
  });

  it('persists a plan artifact via updatePlan and survives a reload (round-trip)', async () => {
    const t = make({ backlogState: 'Backlog' });
    const issue = await t.createIssue({ title: 'plan me', stateName: 'Backlog' });
    expect(await t.getPlan(issue.id)).toBeNull();

    // First write: planning status, no markdown yet.
    await t.updatePlan(issue.id, (prev) => {
      expect(prev).toBeUndefined();
      return {
        status: 'planning',
        qa: [],
        comments: [],
        revision: 0,
        createdAt: 'c',
        updatedAt: 'u',
      };
    });

    // Second write: a question batch goes pending, then markdown is submitted.
    await t.updatePlan(issue.id, (prev) => ({
      ...prev!,
      status: 'awaiting_input',
      pendingAsk: {
        id: 'a1',
        at: 't',
        questions: [
          {
            id: 'q1',
            header: 'Scope',
            question: 'Which?',
            options: [{ label: 'A' }],
            multiSelect: false,
          },
        ],
      },
    }));
    await t.updatePlan(issue.id, (prev) => ({
      ...prev!,
      status: 'ready',
      markdown: '# Plan\n\nstep 1',
      pendingAsk: null,
      qa: [{ id: 'a1', at: 't', questions: [], answers: { q1: 'A' }, answeredAt: 't2' }],
      revision: 1,
    }));

    // Reload from disk through a fresh tracker → the normalized issue + getPlan reflect the writes.
    const reloaded = make({ backlogState: 'Backlog' });
    const plan = await reloaded.getPlan(issue.id);
    expect(plan?.status).toBe('ready');
    expect(plan?.markdown).toBe('# Plan\n\nstep 1');
    expect(plan?.pendingAsk).toBeNull();
    expect(plan?.qa[0]?.answers).toEqual({ q1: 'A' });
    const normalized = (await reloaded.fetchAllIssues()).find((i) => i.id === issue.id);
    expect(normalized?.plan?.markdown).toBe('# Plan\n\nstep 1');
    expect(normalized?.state).toBe('Backlog'); // plan writes never moved the ticket
  });

  it('additively adds a newly-configured Backlog lane to an existing project (leftmost, idempotent)', async () => {
    // A project first created without a Backlog state.
    const before = await make().listWorkflowStates();
    expect(before.map((s) => s.name)).toEqual([
      'Todo',
      'In Progress',
      'Human Review',
      'Done',
      'Cancelled',
    ]);
    // A later run configures backlogState: ensureSeedStates merges Backlog in at the front,
    // preserving existing entries + order and reindexing positions.
    const after = await make({ backlogState: 'Backlog' }).listWorkflowStates();
    expect(after.map((s) => s.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'Human Review',
      'Done',
      'Cancelled',
    ]);
    expect(after.find((s) => s.name === 'Backlog')?.type).toBe('backlog');
    expect(after.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    // Idempotent — a third run does not duplicate.
    const again = await make({ backlogState: 'Backlog' }).listWorkflowStates();
    expect(again.filter((s) => s.name === 'Backlog')).toHaveLength(1);
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

  it('persists and reads back task usage (no activity entry)', async () => {
    const t = make();
    const updatedAt = '2026-06-19T12:00:00.000Z';
    const issue = await t.createIssue({ title: 'x', stateName: 'Todo' });
    await t.updateIssue(issue.id, {
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        costUsd: 0.05,
        updatedAt,
      },
    });
    const [fresh] = await t.fetchAllIssues();
    expect(fresh?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      costUsd: 0.05,
      updatedAt,
    });
    // Usage is a silent metadata write — it must not create an activity entry.
    expect((await t.fetchActivity(issue.id)).map((a) => a.field)).not.toContain('usage');
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

  it('advertises and performs issue removal (delete + detach)', async () => {
    const t = make();
    expect(supportsIssueRemoval(t)).toBe(true);

    // detach: keep the other attachment + record a deletion activity.
    const issue = await t.createIssue({ title: 'x' });
    await t.attachToIssue(issue.id, '/api/v1/uploads/demo/a/one.png', 'one.png');
    await t.attachToIssue(issue.id, '/api/v1/uploads/demo/b/two.png', 'two.png');
    await t.detachFromIssue(issue.id, '/api/v1/uploads/demo/a/one.png');
    expect((await t.store.readIssue(issue.id))?.attachments).toEqual([
      { url: '/api/v1/uploads/demo/b/two.png', title: 'two.png' },
    ]);
    expect(
      (await t.fetchActivity(issue.id)).some(
        (a) => a.field === 'attachment' && a.verb === 'deleted',
      ),
    ).toBe(true);

    // delete: the issue disappears from the board; deleting a missing issue throws.
    await t.addComment(issue.id, 'bye');
    await t.deleteIssue(issue.id);
    expect(await t.store.readIssue(issue.id)).toBeNull();
    expect(await t.fetchAllIssues()).toEqual([]);
    await expect(t.deleteIssue(issue.id)).rejects.toThrow(/not found/);
  });

  it('surfaces stored attachments on the normalized issue (detail path)', async () => {
    const t = make();
    const issue = await t.createIssue({ title: 'x' });
    await t.attachToIssue(issue.id, '/api/v1/uploads/demo/a/p.png', 'p.png');
    const [normalized] = await t.fetchAllIssues();
    expect(normalized?.attachments).toEqual([
      { url: '/api/v1/uploads/demo/a/p.png', title: 'p.png' },
    ]);
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
