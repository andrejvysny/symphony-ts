import type { OrchestratorSnapshot } from '@symphony/core';
import { describe, expect, it, vi } from 'vitest';
import { createDashboardServer, type DashboardSource } from './server.js';

function seededSnapshot(): OrchestratorSnapshot {
  return {
    generated_at: new Date(0).toISOString(),
    counts: { running: 1, claimed: 1, blocked: 1, retrying: 1, completed: 2, paused: 0 },
    paused: [],
    running: [
      {
        issue_id: 'r1',
        issue_identifier: 'MT-1',
        state: 'In Progress',
        session_id: 's1',
        workspace_path: '/tmp/ws/MT-1',
        turn_count: 2,
        last_event: 'text_delta',
        started_at: new Date(0).toISOString(),
        tokens: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      },
    ],
    blocked: [
      {
        issue_id: 'b1',
        issue_identifier: 'MT-2',
        reason: 'needs a decision',
        blocked_at: new Date(0).toISOString(),
      },
    ],
    retrying: [
      {
        issue_id: 't1',
        issue_identifier: 'MT-3',
        attempt: 1,
        delay_type: 'failure',
        due_at: new Date(0).toISOString(),
        error: 'boom',
      },
    ],
    codex_totals: { input_tokens: 100, output_tokens: 40, total_tokens: 140, seconds_running: 12 },
    rate_limits: null,
  };
}

function fakeSource(): DashboardSource {
  const snap = seededSnapshot();
  return {
    snapshot: () => snap,
    findIssue: (id) => snap.running.find((r) => r.issue_identifier === id) ?? null,
    requestRefresh: vi.fn().mockResolvedValue({ coalesced: false }),
    capabilities: () => ({ board: true, write: true }),
    getBoard: vi.fn().mockResolvedValue({
      states: [
        { id: 's1', name: 'Todo', type: 'unstarted', position: 0 },
        { id: 's2', name: 'Done', type: 'completed', position: 1 },
      ],
      columns: {
        Todo: [
          {
            id: 'i1',
            identifier: 'MT-1',
            title: 'a',
            state: 'Todo',
            priority: null,
            labels: [],
            url: null,
            status: 'running',
          },
        ],
        Done: [],
      },
    }),
    listStates: vi
      .fn()
      .mockResolvedValue([{ id: 's1', name: 'Todo', type: 'unstarted', position: 0 }]),
    getIssueDetail: vi.fn().mockResolvedValue(null),
    createTicket: vi.fn().mockResolvedValue({ id: 'new1', identifier: 'MT-9' }),
    moveIssue: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    listSessions: () => [
      {
        issue_id: 'r1',
        issue_identifier: 'MT-1',
        state: 'In Progress',
        session_id: 's1',
        tmux_session: null,
        pid: null,
        started_at: new Date(0).toISOString(),
        last_event: 'text_delta',
        turn_count: 2,
        workspace_path: null,
        tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    ],
    terminate: vi.fn().mockResolvedValue({ terminated: true }),
    terminateAll: vi.fn().mockResolvedValue({ terminated: 2 }),
    unblock: vi.fn().mockResolvedValue({ unblocked: true }),
    subscribeLogs: vi.fn().mockReturnValue(() => {}),
  };
}

function multipart(parts: {
  fields?: Record<string, string>;
  file?: { name: string; content: string };
}): {
  headers: Record<string, string>;
  payload: string;
} {
  const b = '----symphonytest';
  const lines: string[] = [];
  for (const [k, v] of Object.entries(parts.fields ?? {})) {
    lines.push(`--${b}`, `Content-Disposition: form-data; name="${k}"`, '', v);
  }
  if (parts.file) {
    lines.push(
      `--${b}`,
      `Content-Disposition: form-data; name="files"; filename="${parts.file.name}"`,
      'Content-Type: text/plain',
      '',
      parts.file.content,
    );
  }
  lines.push(`--${b}--`, '');
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    payload: lines.join('\r\n'),
  };
}

describe('dashboard server', () => {
  it('serves the HTML dashboard at /', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Symphony');
    await app.close();
  });

  it('returns the state snapshot as JSON', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/api/v1/state' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts.running).toBe(1);
    expect(body.codex_totals.total_tokens).toBe(140);
    await app.close();
  });

  it('returns a known issue and 404 for unknown', async () => {
    const app = createDashboardServer(fakeSource());
    const ok = await app.inject({ method: 'GET', url: '/api/v1/MT-1' });
    expect(ok.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/NOPE-9' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('issue_not_found');
    await app.close();
  });

  it('accepts POST /api/v1/refresh with 202', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const res = await app.inject({ method: 'POST', url: '/api/v1/refresh' });
    expect(res.statusCode).toBe(202);
    expect(res.json().operations).toEqual(['poll', 'reconcile']);
    expect(source.requestRefresh).toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/sessions/:id/unblock clears a blocked issue', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const res = await app.inject({ method: 'POST', url: '/api/v1/sessions/mem-1/unblock' });
    expect(res.statusCode).toBe(200);
    expect(res.json().unblocked).toBe(true);
    expect(source.unblock).toHaveBeenCalledWith('mem-1');
    await app.close();
  });

  it('serves /healthz', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    await app.close();
  });

  it('rate-limits rapid /api/v1/refresh calls', async () => {
    const app = createDashboardServer(fakeSource());
    const first = await app.inject({ method: 'POST', url: '/api/v1/refresh' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/refresh' });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  it('returns 405 for disallowed methods on known routes', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'POST', url: '/api/v1/state' });
    expect(res.statusCode).toBe(405);
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/refresh' });
    expect(res2.statusCode).toBe(405);
    await app.close();
  });

  it('serves the board grouped by state', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/api/v1/board' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.states.map((s: { name: string }) => s.name)).toEqual(['Todo', 'Done']);
    expect(body.columns.Todo).toHaveLength(1);
    await app.close();
  });

  it('serves workflow states and sessions', async () => {
    const app = createDashboardServer(fakeSource());
    expect((await app.inject({ method: 'GET', url: '/api/v1/states' })).statusCode).toBe(200);
    const sessions = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
    expect(sessions.json().sessions).toHaveLength(1);
    await app.close();
  });

  it('creates a ticket from multipart with a file', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const { headers, payload } = multipart({
      fields: { title: 'Hello ticket', description: 'do it', stateId: 's1' },
      file: { name: 'a.txt', content: 'file-body' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers, payload });
    expect(res.statusCode).toBe(201);
    expect(res.json().identifier).toBe('MT-9');
    expect(source.createTicket).toHaveBeenCalledOnce();
    const arg = (source.createTicket as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.title).toBe('Hello ticket');
    expect(arg.files).toHaveLength(1);
    expect(arg.files[0].filename).toBe('a.txt');
    await app.close();
  });

  it('rejects a ticket without a title', async () => {
    const app = createDashboardServer(fakeSource());
    const { headers, payload } = multipart({ fields: { description: 'no title' } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers, payload });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('moves an issue to a new state', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/issues/i1/state',
      payload: { stateId: 's2' },
    });
    expect(res.statusCode).toBe(200);
    expect(source.moveIssue).toHaveBeenCalledWith('i1', 's2');
    const bad = await app.inject({ method: 'PATCH', url: '/api/v1/issues/i1/state', payload: {} });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('terminates a session and all sessions', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const one = await app.inject({ method: 'POST', url: '/api/v1/sessions/r1/terminate' });
    expect(one.json().terminated).toBe(true);
    expect(source.terminate).toHaveBeenCalledWith('r1');
    const all = await app.inject({ method: 'POST', url: '/api/v1/sessions/terminate-all' });
    expect(all.json().terminated).toBe(2);
    await app.close();
  });
});
