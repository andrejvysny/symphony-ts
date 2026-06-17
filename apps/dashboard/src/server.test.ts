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
    runtimeInfo: () => ({
      backend: 'claude-sdk',
      branch_prefix: 'symphony/',
      max_concurrent_agents: 4,
      poll_interval_ms: 5000,
      max_turns: 6,
      max_continuations: 50,
      stall_timeout_ms: 900_000,
    }),
    findIssue: (id) => snap.running.find((r) => r.issue_identifier === id) ?? null,
    requestRefresh: vi.fn().mockResolvedValue({ coalesced: false }),
    capabilities: () => ({ board: true, write: true, projects: true, settings: true }),
    listProjects: vi.fn().mockResolvedValue({
      projects: [
        {
          project_id: 'p1',
          name: 'Alpha',
          identifier: 'ALP',
          repo: '~/code/alpha',
          registered: true,
          active: true,
        },
      ],
      active_project_id: 'p1',
    }),
    switchProject: vi.fn().mockResolvedValue({ switched: true }),
    createProject: vi.fn().mockResolvedValue({
      project_id: 'p2',
      name: 'Beta',
      identifier: 'BET',
      repo: '~/code/beta',
      registered: true,
      active: false,
    }),
    getSettings: () => ({
      agent: {
        backend: 'claude-sdk',
        model: null,
        permission_mode: 'bypassPermissions',
        max_turns: 6,
        max_continuations: 50,
        max_concurrent_agents: 4,
        max_retry_backoff_ms: 300_000,
        turn_timeout_ms: 3_600_000,
        stall_timeout_ms: 900_000,
        tmux: false,
        max_budget_usd: null,
      },
      polling: { interval_ms: 5000 },
      workspace: { branch_prefix: 'symphony/' },
    }),
    updateSettings: vi.fn().mockResolvedValue(undefined),
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
    listLabels: vi.fn().mockResolvedValue([{ id: 'l1', name: 'docs' }]),
    getIssueDetail: vi.fn().mockResolvedValue(null),
    createTicket: vi.fn().mockResolvedValue({ id: 'new1', identifier: 'MT-9' }),
    moveIssue: vi.fn().mockResolvedValue(undefined),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    listSessions: () => [
      {
        issue_id: 'r1',
        issue_identifier: 'MT-1',
        state: 'In Progress',
        session_id: 's1',
        tmux_session: null,
        pid: null,
        backend: 'claude-sdk',
        started_at: new Date(0).toISOString(),
        last_event: 'text_delta',
        last_event_at: new Date(0).toISOString(),
        last_action: 'Edit: index.ts',
        turn_count: 2,
        continuation_count: 0,
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

  it('returns runtime meta as JSON', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      backend: 'claude-sdk',
      branch_prefix: 'symphony/',
      max_concurrent_agents: 4,
      poll_interval_ms: 5000,
      max_turns: 6,
      max_continuations: 50,
      stall_timeout_ms: 900_000,
    });
    expect((await app.inject({ method: 'POST', url: '/api/v1/meta' })).statusCode).toBe(405);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/meta' })).statusCode).toBe(405);
    await app.close();
  });

  it('lists project labels', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/api/v1/labels' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'l1', name: 'docs' }]);
    await app.close();
  });

  it('edits an issue and rejects an empty edit', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/v1/issues/i1',
      payload: { title: 'Renamed', priority: 2, labels: ['docs'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(source.updateIssue).toHaveBeenCalledWith('i1', {
      title: 'Renamed',
      priority: 2,
      labels: ['docs'],
    });
    const empty = await app.inject({ method: 'PATCH', url: '/api/v1/issues/i1', payload: {} });
    expect(empty.statusCode).toBe(400);
    await app.close();
  });

  it('exposes enriched session signals', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/api/v1/sessions' });
    const s = res.json().sessions[0];
    expect(s.backend).toBe('claude-sdk');
    expect(s.last_action).toBe('Edit: index.ts');
    expect(s.continuation_count).toBe(0);
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

  it('exposes capabilities', async () => {
    const app = createDashboardServer(fakeSource());
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ board: true, write: true, projects: true, settings: true });
    expect((await app.inject({ method: 'POST', url: '/api/v1/capabilities' })).statusCode).toBe(
      405,
    );
    await app.close();
  });

  it('lists projects and switches the active one', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(list.statusCode).toBe(200);
    expect(list.json().active_project_id).toBe('p1');
    expect(list.json().projects[0].name).toBe('Alpha');

    const sw = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/switch',
      payload: { projectId: 'p2' },
    });
    expect(sw.statusCode).toBe(200);
    expect(sw.json().switched).toBe(true);
    expect(source.switchProject).toHaveBeenCalledWith('p2');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/switch',
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('creates a project and validates required fields', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Beta', identifier: 'BET', repo: '~/code/beta' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().project_id).toBe('p2');
    expect(source.createProject).toHaveBeenCalledWith({
      name: 'Beta',
      identifier: 'BET',
      repo: '~/code/beta',
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Beta' },
    });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it('reads and updates settings', async () => {
    const source = fakeSource();
    const app = createDashboardServer(source);
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(get.statusCode).toBe(200);
    expect(get.json().agent.backend).toBe('claude-sdk');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { agent: { max_concurrent_agents: 8 }, polling: { interval_ms: 10_000 } },
    });
    expect(patch.statusCode).toBe(200);
    expect(source.updateSettings).toHaveBeenCalledWith({
      agent: { max_concurrent_agents: 8 },
      polling: { interval_ms: 10_000 },
    });

    const empty = await app.inject({ method: 'PATCH', url: '/api/v1/settings', payload: {} });
    expect(empty.statusCode).toBe(400);
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
