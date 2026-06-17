import { describe, expect, it } from 'vitest';
import { PlaneWorkspaceClient } from './workspace-client.js';
import type { Transport, TransportResponse } from '../http/transport.js';

function ok(body: unknown): TransportResponse {
  return { statusCode: 200, headers: {}, json: async () => body, dump: async () => {} };
}

function makeClient(transport: Transport) {
  return new PlaneWorkspaceClient({
    endpoint: 'http://x',
    apiKey: 'k',
    workspaceSlug: 'ws',
    transport,
    sleep: async () => {},
  });
}

describe('PlaneWorkspaceClient', () => {
  it('lists projects from the workspace endpoint (bare array)', async () => {
    let url = '';
    const client = makeClient(async (u) => {
      url = u;
      return ok([
        { id: 'p1', name: 'Alpha', identifier: 'ALP' },
        { id: 'p2', name: 'Beta', identifier: 'BET' },
        { name: 'NoId' }, // dropped (no id)
      ]);
    });
    const projects = await client.listProjects();
    expect(url).toContain('http://x/api/v1/workspaces/ws/projects/');
    expect(projects).toEqual([
      { id: 'p1', name: 'Alpha', identifier: 'ALP' },
      { id: 'p2', name: 'Beta', identifier: 'BET' },
    ]);
  });

  it('creates a project and returns its id/identifier', async () => {
    let captured: { method: string; body?: string } | undefined;
    const client = makeClient(async (_u, init) => {
      captured = init;
      return ok({ id: 'new', name: 'Gamma', identifier: 'GAM' });
    });
    const created = await client.createProject({ name: 'Gamma', identifier: 'GAM' });
    expect(created).toEqual({ id: 'new', name: 'Gamma', identifier: 'GAM' });
    expect(captured?.method).toBe('POST');
    expect(JSON.parse(captured!.body!)).toEqual({ name: 'Gamma', identifier: 'GAM' });
  });

  it('seedStates creates only the states the project lacks', async () => {
    const created: string[] = [];
    const client = makeClient(async (u, init) => {
      if (init.method === 'GET') {
        return ok([{ name: 'Todo' }, { name: 'Done' }]); // existing states
      }
      const body = JSON.parse(init.body!) as { name: string };
      created.push(body.name);
      expect(u).toContain('/projects/pid/states/');
      return ok({ id: 's', name: body.name });
    });
    const res = await client.seedStates('pid', ['Todo', 'Rework', 'Done', 'Merging']);
    expect(res.created).toEqual(['Rework', 'Merging']);
    expect(res.skipped).toEqual(['Todo', 'Done']);
    expect(created).toEqual(['Rework', 'Merging']);
  });

  it('seedStates swallows per-state failures (best effort)', async () => {
    const client = makeClient(async (_u, init) => {
      if (init.method === 'GET') return ok([]);
      return { statusCode: 400, headers: {}, json: async () => ({}), dump: async () => {} };
    });
    const res = await client.seedStates('pid', ['Rework']);
    expect(res.created).toEqual([]);
    expect(res.skipped).toEqual(['Rework']);
  });
});
