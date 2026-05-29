import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CreateTicketInput, DashboardSource } from '@symphony/core';
import { DASHBOARD_HTML } from './html.js';

export type { DashboardSource } from '@symphony/core';

/** Built Preact client dir (dist/client), resolved relative to the built server (dist/index.js). */
const CLIENT_DIR = fileURLToPath(new URL('./client', import.meta.url));
const HAS_CLIENT = existsSync(`${CLIENT_DIR}/index.html`);

const OTHER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const REFRESH_MIN_INTERVAL_MS = 500;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function createDashboardServer(source: DashboardSource): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 10 } });

  const methodNotAllowed = (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => reply.code(405).send({ error: { code: 'method_not_allowed' } });

  // ---- UI ----
  // Serve the built Preact client when present (production); otherwise fall back to the
  // inline single-file dashboard (dev / when the client hasn't been built).
  if (HAS_CLIENT) {
    void app.register(fastifyStatic, { root: CLIENT_DIR, prefix: '/' });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(DASHBOARD_HTML));
    app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  }
  app.route({ method: [...OTHER_METHODS], url: '/', handler: methodNotAllowed });
  app.get('/healthz', async () => ({ status: 'ok' }));

  // ---- read ----
  app.get('/api/v1/state', async () => source.snapshot());
  app.route({ method: [...OTHER_METHODS], url: '/api/v1/state', handler: methodNotAllowed });

  app.get('/api/v1/board', async (_req, reply) => {
    try {
      return await source.getBoard();
    } catch (e) {
      return reply
        .code(503)
        .send({ error: { code: 'board_unavailable', message: (e as Error).message } });
    }
  });

  app.get('/api/v1/states', async (_req, reply) => {
    try {
      return await source.listStates();
    } catch (e) {
      return reply
        .code(503)
        .send({ error: { code: 'states_unavailable', message: (e as Error).message } });
    }
  });

  app.get('/api/v1/sessions', async () => ({ sessions: source.listSessions() }));

  // ---- writes ----
  app.post('/api/v1/tickets', async (req, reply) => {
    const fields: Record<string, string> = {};
    const files: NonNullable<CreateTicketInput['files']> = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          files.push({
            filename: part.filename,
            contentType: part.mimetype,
            data: await part.toBuffer(),
          });
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (e) {
      return reply
        .code(400)
        .send({ error: { code: 'bad_multipart', message: (e as Error).message } });
    }
    if (!fields['title']) return reply.code(400).send({ error: { code: 'missing_title' } });
    const input: CreateTicketInput = { title: fields['title'], files };
    if (fields['description']) input.description = fields['description'];
    if (fields['stateId']) input.stateId = fields['stateId'];
    try {
      const created = await source.createTicket(input);
      return reply.code(201).send(created);
    } catch (e) {
      return reply
        .code(502)
        .send({ error: { code: 'create_failed', message: (e as Error).message } });
    }
  });
  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/v1/tickets',
    handler: methodNotAllowed,
  });

  app.patch<{ Params: { id: string }; Body: { stateId?: string } }>(
    '/api/v1/issues/:id/state',
    async (req, reply) => {
      const stateId = req.body?.stateId;
      if (!stateId) return reply.code(400).send({ error: { code: 'missing_stateId' } });
      try {
        await source.moveIssue(req.params.id, stateId);
        return reply.code(200).send({ ok: true });
      } catch (e) {
        return reply
          .code(502)
          .send({ error: { code: 'move_failed', message: (e as Error).message } });
      }
    },
  );

  app.post<{ Params: { issueId: string } }>('/api/v1/sessions/:issueId/terminate', async (req) =>
    source.terminate(req.params.issueId),
  );
  app.post('/api/v1/sessions/terminate-all', async () => source.terminateAll());

  // ---- live logs (SSE) ----
  app.get<{ Params: { issueId: string } }>('/api/v1/sessions/:issueId/logs', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('event: open\ndata: {}\n\n');
    const unsubscribe = source.subscribeLogs(req.params.issueId, (ev) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    req.raw.on('close', unsubscribe);
  });

  // ---- refresh (rate-limited) ----
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

  // ---- issue detail (param route LAST; static routes above take precedence) ----
  app.get<{ Params: { identifier: string } }>('/api/v1/:identifier', async (req, reply) => {
    const found = source.findIssue(req.params.identifier);
    if (!found) return reply.code(404).send({ error: { code: 'issue_not_found' } });
    return reply.send(found);
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found' } }));
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
  if (!LOOPBACK_HOSTS.has(host)) opts.onNonLoopback?.(host);
  const app = createDashboardServer(source);
  await app.listen({ port: opts.port, host });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return { app, port, close: () => app.close() };
}
