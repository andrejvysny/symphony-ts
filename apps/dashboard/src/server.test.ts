import type { OrchestratorSnapshot } from '@symphony/core';
import { describe, expect, it, vi } from 'vitest';
import { createDashboardServer, type DashboardSource } from './server.js';

function seededSnapshot(): OrchestratorSnapshot {
  return {
    generated_at: new Date(0).toISOString(),
    counts: { running: 1, claimed: 1, blocked: 1, retrying: 1, completed: 2 },
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
});
