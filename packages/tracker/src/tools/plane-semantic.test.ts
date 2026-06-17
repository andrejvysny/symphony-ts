import { describe, expect, it } from 'vitest';
import { makePlaneSemanticTools, type SemanticPlaneClient } from './plane-semantic.js';

interface Fixtures {
  workItem?: Record<string, unknown> | null;
  states?: Array<{ id: string; name?: string }>;
  comments?: Array<Record<string, unknown>>;
}

function fakeClient(f: Fixtures): {
  client: SemanticPlaneClient;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client: SemanticPlaneClient = {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
      if (method === 'GET') return (f.workItem ?? null) as T;
      return undefined as T;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      if (path === '/states/') return (f.states ?? []) as T[];
      if (path.endsWith('/comments/')) return (f.comments ?? []) as T[];
      return [] as T[];
    },
  };
  return { client, calls };
}

const parse = (output: string): { data?: unknown; error?: string } =>
  JSON.parse(output) as { data?: unknown; error?: string };

describe('makePlaneSemanticTools', () => {
  describe('getTask', () => {
    it('returns title, plaintext description, resolved status name, and comments', async () => {
      const { client } = fakeClient({
        workItem: {
          id: 'i1',
          name: 'Add login',
          description_html: '<p>Do &amp; verify</p>',
          state: 's-todo',
        },
        states: [
          { id: 's-todo', name: 'Todo' },
          { id: 's-rev', name: 'Human Review' },
        ],
        comments: [{ created_at: 't1', comment_stripped: 'first' }],
      });
      const { getTask } = makePlaneSemanticTools(client);
      const r = await getTask({ task_id: 'i1' });
      expect(r.success).toBe(true);
      const data = parse(r.output).data as {
        title: string;
        description: string;
        status: string;
        comments: Array<{ body: string }>;
      };
      expect(data.title).toBe('Add login');
      expect(data.description).toBe('Do & verify');
      expect(data.status).toBe('Todo');
      expect(data.comments[0]?.body).toBe('first');
    });

    it('rejects a task_id that could escape the path', async () => {
      const { getTask } = makePlaneSemanticTools(fakeClient({}).client);
      const r = await getTask({ task_id: '../states' });
      expect(r.success).toBe(false);
      expect(parse(r.output).error).toContain('valid issue id');
    });

    it('reports not-found when the work item is missing', async () => {
      const { getTask } = makePlaneSemanticTools(fakeClient({ workItem: null }).client);
      const r = await getTask({ task_id: 'missing' });
      expect(r.success).toBe(false);
      expect(parse(r.output).error).toContain('not found');
    });
  });

  describe('updateStatus', () => {
    it('resolves the status name to its state id and PATCHes the work item', async () => {
      const { client, calls } = fakeClient({ states: [{ id: 's-rev', name: 'Human Review' }] });
      const { updateStatus } = makePlaneSemanticTools(client);
      const r = await updateStatus({ task_id: 'i1', status: 'Human Review' });
      expect(r.success).toBe(true);
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.path).toBe('/work-items/i1/');
      expect(patch?.body).toEqual({ state: 's-rev' });
    });

    it('errors and lists available states when the status is unknown', async () => {
      const { client } = fakeClient({ states: [{ id: 's-todo', name: 'Todo' }] });
      const { updateStatus } = makePlaneSemanticTools(client);
      const r = await updateStatus({ task_id: 'i1', status: 'Nope' });
      expect(r.success).toBe(false);
      expect(parse(r.output).error).toContain('Todo');
    });

    it('rejects an invalid task_id', async () => {
      const { updateStatus } = makePlaneSemanticTools(fakeClient({}).client);
      const r = await updateStatus({ task_id: 'a/b', status: 'Todo' });
      expect(r.success).toBe(false);
    });
  });

  describe('addComment', () => {
    it('posts the comment as escaped HTML and reports success', async () => {
      const { client, calls } = fakeClient({});
      const { addComment } = makePlaneSemanticTools(client);
      const r = await addComment({ task_id: 'i1', body: 'done <ok>' });
      expect(r.success).toBe(true);
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.path).toBe('/work-items/i1/comments/');
      expect(post?.body).toEqual({ comment_html: '<p>done &lt;ok&gt;</p>' });
    });

    it('rejects an empty body', async () => {
      const { addComment } = makePlaneSemanticTools(fakeClient({}).client);
      const r = await addComment({ task_id: 'i1', body: '   ' });
      expect(r.success).toBe(false);
    });
  });
});
