import Fastify, { type FastifyInstance } from 'fastify';
import type { OrchestratorSnapshot } from '@symphony/core';
import { DASHBOARD_HTML } from './html.js';

/** What the dashboard needs from the orchestrator (Orchestrator satisfies this). */
export interface DashboardSource {
  snapshot(): OrchestratorSnapshot;
  findIssue(identifier: string): unknown;
  requestRefresh(): Promise<{ coalesced: boolean }>;
}

const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const REFRESH_MIN_INTERVAL_MS = 500;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function createDashboardServer(source: DashboardSource): FastifyInstance {
  const app = Fastify({ logger: false });

  const methodNotAllowed = (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => reply.code(405).send({ error: { code: 'method_not_allowed' } });

  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(DASHBOARD_HTML);
  });
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  app.route({ method: [...OTHER_METHODS], url: '/', handler: methodNotAllowed });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/api/v1/state', async () => source.snapshot());
  app.route({ method: [...OTHER_METHODS], url: '/api/v1/state', handler: methodNotAllowed });

  // Light rate-limit: at most one manual refresh per REFRESH_MIN_INTERVAL_MS.
  let lastRefreshAt = 0;
  app.post('/api/v1/refresh', async (_req, reply) => {
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
      return reply.code(429).send({ error: { code: 'rate_limited' } });
    }
    lastRefreshAt = now;
    const { coalesced } = await source.requestRefresh();
    return reply.code(202).send({
      queued: true,
      coalesced,
      requested_at: new Date(now).toISOString(),
      operations: ['poll', 'reconcile'],
    });
  });
  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/v1/refresh',
    handler: methodNotAllowed,
  });

  app.get<{ Params: { identifier: string } }>('/api/v1/:identifier', async (req, reply) => {
    const found = source.findIssue(req.params.identifier);
    if (!found) return reply.code(404).send({ error: { code: 'issue_not_found' } });
    return reply.send(found);
  });
  app.route({ method: [...OTHER_METHODS], url: '/api/v1/:identifier', handler: methodNotAllowed });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found' } });
  });

  return app;
}

export interface DashboardHandle {
  app: FastifyInstance;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the dashboard listening on host:port (loopback by default). The dashboard
 * has NO authentication — binding to a non-loopback host is unsafe; we warn via
 * `onNonLoopback` so the caller can log it.
 */
export async function startDashboard(
  source: DashboardSource,
  opts: { port: number; host?: string; onNonLoopback?: (host: string) => void },
): Promise<DashboardHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && host !== '127.0.0.1') {
    opts.onNonLoopback?.(host);
  }
  const app = createDashboardServer(source);
  await app.listen({ port: opts.port, host });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return { app, port, close: () => app.close() };
}
