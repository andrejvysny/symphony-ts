import { describe, expect, it } from 'vitest';
import { PlaneTracker } from './adapter.js';
import type { Transport, TransportResponse } from '../http/transport.js';

function fakeResponse(statusCode: number, body: unknown): TransportResponse {
  return {
    statusCode,
    headers: {},
    json: async () => body,
    dump: async () => {},
  };
}

// Counters for tracking memoization
interface Counters {
  states: number;
  labels: number;
  project: number;
  workItems: number;
}

// Minimal fake states: Todo, In Progress, Done
const FAKE_STATES = [
  { id: 'state-todo', name: 'Todo', group: 'unstarted', sequence: 1 },
  { id: 'state-inprogress', name: 'In Progress', group: 'started', sequence: 2 },
  { id: 'state-done', name: 'Done', group: 'completed', sequence: 3 },
];

const FAKE_LABELS = [
  { id: 'lbl-1', name: 'Bug' },
  { id: 'lbl-2', name: 'Feature' },
];

const FAKE_PROJECT = { identifier: 'SYM' };

const FAKE_ISSUES = [
  {
    id: 'issue-1',
    sequence_id: 1,
    name: 'First issue',
    state: 'state-todo',
    labels: ['lbl-1'],
    priority: 'high',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  },
  {
    id: 'issue-2',
    sequence_id: 2,
    name: 'Second issue',
    state: 'state-inprogress',
    labels: ['lbl-2'],
    priority: 'medium',
  },
  {
    id: 'issue-3',
    sequence_id: 3,
    name: 'Done issue',
    state: 'state-done',
    labels: [],
    priority: 'none',
  },
];

function makeRouterTransport(
  counters: Counters,
  overrides?: {
    workItemsById?: Record<string, unknown>;
    capturePatches?: Array<{ url: string; body: unknown }>;
    capturePosts?: Array<{ url: string; body: unknown }>;
  },
): Transport {
  return async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;

    if (init.method === 'GET' && path.endsWith('/states/')) {
      counters.states++;
      return fakeResponse(200, FAKE_STATES);
    }

    if (init.method === 'GET' && path.endsWith('/labels/')) {
      counters.labels++;
      return fakeResponse(200, FAKE_LABELS);
    }

    // Project meta: GET /api/v1/workspaces/ws/projects/pid/
    if (
      init.method === 'GET' &&
      /\/projects\/[^/]+\/$/.test(path) &&
      !path.includes('/work-items')
    ) {
      counters.project++;
      return fakeResponse(200, FAKE_PROJECT);
    }

    if (init.method === 'GET' && path.endsWith('/activities/')) {
      return fakeResponse(200, {
        results: [
          {
            created_at: '2024-01-02T00:00:00Z',
            field: 'state',
            verb: 'updated',
            old_value: 'Todo',
            new_value: 'Human Review',
          },
          {
            created_at: '2024-01-01T00:00:00Z',
            field: null,
            verb: 'created',
            old_value: null,
            new_value: null,
          },
        ],
        next_page_results: false,
      });
    }

    if (init.method === 'GET' && path.endsWith('/comments/')) {
      return fakeResponse(200, {
        results: [
          {
            created_at: '2024-01-03T00:00:00Z',
            comment_stripped: 'looks good',
            comment_html: '<p>looks good</p>',
          },
          {
            created_at: '2024-01-04T00:00:00Z',
            comment_stripped: null,
            comment_html: '<p>second &amp; <b>bold</b></p>',
          },
        ],
        next_page_results: false,
      });
    }

    if (init.method === 'GET' && path.endsWith('/work-items/')) {
      counters.workItems++;
      return fakeResponse(200, FAKE_ISSUES);
    }

    // Individual work item by ID
    if (init.method === 'GET' && path.includes('/work-items/')) {
      const match = /\/work-items\/([^/]+)\/$/.exec(path);
      const id = match?.[1];
      if (id && overrides?.workItemsById && id in overrides.workItemsById) {
        const item = overrides.workItemsById[id];
        if (item === null) return fakeResponse(404, null);
        return fakeResponse(200, item);
      }
      return fakeResponse(404, null);
    }

    if (init.method === 'PATCH' && path.includes('/work-items/')) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      overrides?.capturePatches?.push({ url, body });
      return fakeResponse(200, { id: 'patched' });
    }

    if (init.method === 'POST' && path.includes('/comments/')) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      overrides?.capturePosts?.push({ url, body });
      return fakeResponse(201, { id: 'comment-1' });
    }

    if (init.method === 'POST' && path.endsWith('/work-items/')) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      overrides?.capturePosts?.push({ url, body });
      // Return a fake created issue
      return fakeResponse(201, {
        id: 'new-issue',
        sequence_id: 99,
        name: body?.name ?? 'New',
        state: body?.state ?? 'state-todo',
        labels: [],
        priority: body?.priority ?? 'none',
      });
    }

    throw new Error(`Unexpected transport call: ${init.method} ${url}`);
  };
}

function makeTracker(
  counters: Counters,
  opts?: {
    activeStates?: string[];
    workItemsById?: Record<string, unknown>;
    capturePatches?: Array<{ url: string; body: unknown }>;
    capturePosts?: Array<{ url: string; body: unknown }>;
  },
) {
  return new PlaneTracker({
    endpoint: 'http://x',
    apiKey: 'k',
    workspaceSlug: 'ws',
    projectId: 'pid',
    activeStates: opts?.activeStates ?? ['Todo', 'In Progress'],
    transport: makeRouterTransport(counters, {
      ...(opts?.workItemsById !== undefined ? { workItemsById: opts.workItemsById } : {}),
      ...(opts?.capturePatches !== undefined ? { capturePatches: opts.capturePatches } : {}),
      ...(opts?.capturePosts !== undefined ? { capturePosts: opts.capturePosts } : {}),
    }),
    sleep: async () => {},
  });
}

describe('PlaneTracker.fetchCandidateIssues', () => {
  it('returns only issues whose state name is in activeStates', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    const issues = await tracker.fetchCandidateIssues();

    expect(issues.map((i) => i.id)).toEqual(['issue-1', 'issue-2']);
    expect(issues.find((i) => i.id === 'issue-3')).toBeUndefined();
  });

  it('builds identifiers as SYM-<seq>', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    const issues = await tracker.fetchCandidateIssues();
    expect(issues[0]?.identifier).toBe('SYM-1');
    expect(issues[1]?.identifier).toBe('SYM-2');
  });

  it('resolves labels by UUID', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    const issues = await tracker.fetchCandidateIssues();
    expect(issues[0]?.labels).toEqual(['bug']);
    expect(issues[1]?.labels).toEqual(['feature']);
  });
});

describe('PlaneTracker memoization', () => {
  it('fetches /states/, /labels/, and project meta only once across two calls', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    await tracker.fetchCandidateIssues();
    await tracker.fetchCandidateIssues();

    expect(counters.states).toBe(1);
    expect(counters.labels).toBe(1);
    expect(counters.project).toBe(1);
  });
});

describe('PlaneTracker.fetchIssuesByStates', () => {
  it('filters issues by given state names', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters, { activeStates: ['Todo', 'In Progress'] });

    const issues = await tracker.fetchIssuesByStates(['Done']);
    expect(issues.map((i) => i.id)).toEqual(['issue-3']);
  });
});

describe('PlaneTracker.fetchIssueStatesByIds', () => {
  it('returns state refs for found ids, omits missing ones', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters, {
      workItemsById: {
        id1: {
          id: 'id1',
          sequence_id: 5,
          name: 'Found',
          state: 'state-todo',
          labels: [],
        },
        missing: null, // 404
      },
    });

    const refs = await tracker.fetchIssueStatesByIds(['id1', 'missing']);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe('id1');
    expect(refs[0]?.state).toBe('Todo');
  });

  it('returns [] when given empty ids', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    const refs = await tracker.fetchIssueStatesByIds([]);
    expect(refs).toEqual([]);
  });
});

describe('PlaneTracker.listWorkflowStates', () => {
  it('maps group→type, sequence→position, sorted ascending', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    const states = await tracker.listWorkflowStates();

    expect(states.map((s) => s.name)).toEqual(['Todo', 'In Progress', 'Done']);
    expect(states[0]?.type).toBe('unstarted');
    expect(states[1]?.type).toBe('started');
    expect(states[2]?.type).toBe('completed');
    expect(states[0]?.position).toBe(1);
    expect(states[1]?.position).toBe(2);
    expect(states[2]?.position).toBe(3);
  });
});

describe('PlaneTracker.updateIssueState', () => {
  it('sends PATCH to /work-items/{id}/ with body {state: stateId}', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const patches: Array<{ url: string; body: unknown }> = [];
    const tracker = makeTracker(counters, { capturePatches: patches });

    await tracker.updateIssueState('iid', 'sid');

    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain('/work-items/iid/');
    expect(patches[0]?.body).toEqual({ state: 'sid' });
  });
});

describe('PlaneTracker.addComment', () => {
  it('POSTs to /work-items/{id}/comments/ with comment_html wrapping text in <p>', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const posts: Array<{ url: string; body: unknown }> = [];
    const tracker = makeTracker(counters, { capturePosts: posts });

    await tracker.addComment('iid', 'hello');

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain('/work-items/iid/comments/');
    expect((posts[0]?.body as Record<string, unknown>)?.['comment_html']).toBe('<p>hello</p>');
  });
});

describe('PlaneTracker.createIssue', () => {
  it('resolves stateName to UUID, sends correct fields, returns normalized issue', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const posts: Array<{ url: string; body: unknown }> = [];
    const tracker = makeTracker(counters, { capturePosts: posts });

    const issue = await tracker.createIssue({
      title: 'T',
      stateName: 'Todo',
      priority: 2,
      description: 'd',
    });

    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as Record<string, unknown>;
    expect(body?.['name']).toBe('T');
    expect(body?.['state']).toBe('state-todo');
    expect(body?.['priority']).toBe('high');
    expect(body?.['description_html']).toContain('d');
    expect(issue.id).toBe('new-issue');
  });

  it('throws when stateName is not found in project', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    await expect(tracker.createIssue({ title: 'T', stateName: 'Nonexistent' })).rejects.toThrow(
      /not found/,
    );
  });
});

describe('PlaneTracker.uploadFile', () => {
  it('returns assetUrl starting with plane-pending:', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);

    const result = await tracker.uploadFile({
      filename: 'a.txt',
      contentType: 'text/plain',
      data: Buffer.from('x'),
    });

    expect(result.assetUrl).toMatch(/^plane-pending:/);
  });
});

describe('PlaneTracker.attachToIssue', () => {
  it('external URL: POSTs a comment containing the link (no native attach)', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const posts: Array<{ url: string; body: unknown }> = [];
    const tracker = makeTracker(counters, { capturePosts: posts });

    await tracker.attachToIssue('iid', 'https://ext/x', 't');

    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as Record<string, unknown>;
    const html = body?.['comment_html'] as string;
    expect(html).toContain('https://ext/x');
    // TODO: test native MinIO presigned upload path (uses global fetch — skipped here)
  });
});

describe('PlaneTracker.fetchActivity / fetchComments', () => {
  it('returns activity oldest-first with mapped fields', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);
    const acts = await tracker.fetchActivity('issue-1');
    expect(acts.map((a) => a.verb)).toEqual(['created', 'updated']);
    expect(acts[1]).toMatchObject({ field: 'state', oldValue: 'Todo', newValue: 'Human Review' });
  });

  it('returns comments oldest-first, stripping/decoding HTML when no stripped text', async () => {
    const counters: Counters = { states: 0, labels: 0, project: 0, workItems: 0 };
    const tracker = makeTracker(counters);
    const comments = await tracker.fetchComments('issue-1');
    expect(comments.map((c) => c.at)).toEqual(['2024-01-03T00:00:00Z', '2024-01-04T00:00:00Z']);
    expect(comments[0]?.body).toBe('looks good');
    expect(comments[1]?.body).toBe('second & bold');
  });
});
