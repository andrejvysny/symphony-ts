import { describe, expect, it } from 'vitest';
import { PlaneClient } from './client.js';
import type { Transport, TransportResponse } from '../http/transport.js';

function fakeResponse(statusCode: number, body: unknown): TransportResponse {
  return {
    statusCode,
    headers: {},
    json: async () => body,
    dump: async () => {},
  };
}

function fakeResponseWithHeaders(
  statusCode: number,
  body: unknown,
  headers: Record<string, string>,
): TransportResponse {
  return {
    statusCode,
    headers,
    json: async () => body,
    dump: async () => {},
  };
}

function makeClient(transport: Transport, opts?: { maxRetries?: number }) {
  return new PlaneClient({
    endpoint: 'http://x',
    apiKey: 'k',
    workspaceSlug: 'ws',
    projectId: 'pid',
    transport,
    sleep: async () => {},
    ...(opts ?? {}),
  });
}

describe('PlaneClient.request', () => {
  it('GET calls transport with correct URL and x-api-key header, no content-type', async () => {
    let capturedUrl = '';
    let capturedInit: Parameters<Transport>[1] | undefined;

    const transport: Transport = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return fakeResponse(200, { ok: true });
    };

    const client = makeClient(transport);
    await client.request('GET', '/states/');

    expect(capturedUrl).toBe('http://x/api/v1/workspaces/ws/projects/pid/states/');
    expect(capturedInit?.headers['x-api-key']).toBe('k');
    expect(capturedInit?.headers['content-type']).toBeUndefined();
    expect(capturedInit?.method).toBe('GET');
    expect(capturedInit?.body).toBeUndefined();
  });

  it('POST with body sets content-type and serializes body', async () => {
    let capturedInit: Parameters<Transport>[1] | undefined;

    const transport: Transport = async (_url, init) => {
      capturedInit = init;
      return fakeResponse(201, { id: '1' });
    };

    const client = makeClient(transport);
    await client.request('POST', '/work-items/', { name: 'Test' });

    expect(capturedInit?.headers['content-type']).toBe('application/json');
    expect(capturedInit?.body).toBe(JSON.stringify({ name: 'Test' }));
  });

  it('PATCH with body sets content-type and serializes body', async () => {
    let capturedInit: Parameters<Transport>[1] | undefined;

    const transport: Transport = async (_url, init) => {
      capturedInit = init;
      return fakeResponse(200, { id: '1' });
    };

    const client = makeClient(transport);
    await client.request('PATCH', '/work-items/abc/', { state: 'done-uuid' });

    expect(capturedInit?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(capturedInit?.body ?? '')).toEqual({ state: 'done-uuid' });
  });

  it('retries on 429 then succeeds on 200, calls sleep', async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];

    const transport: Transport = async () => {
      attempts++;
      if (attempts === 1) return fakeResponseWithHeaders(429, null, { 'retry-after': '0' });
      return fakeResponse(200, { ok: true });
    };

    const client = new PlaneClient({
      endpoint: 'http://x',
      apiKey: 'k',
      workspaceSlug: 'ws',
      projectId: 'pid',
      transport,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const result = await client.request('GET', '/states/');
    expect(attempts).toBe(2);
    expect(sleepCalls).toHaveLength(1);
    expect(result).toEqual({ ok: true });
  });

  it('retries on 503 then succeeds on 200', async () => {
    let attempts = 0;

    const transport: Transport = async () => {
      attempts++;
      if (attempts === 1) return fakeResponse(503, null);
      return fakeResponse(200, { ok: true });
    };

    const client = makeClient(transport);
    const result = await client.request('GET', '/states/');
    expect(attempts).toBe(2);
    expect(result).toEqual({ ok: true });
  });

  it('throws Plane HTTP 404 on 404 response (api key never in message)', async () => {
    const transport: Transport = async () => fakeResponse(404, null);
    const client = makeClient(transport);

    await expect(client.request('GET', '/missing/')).rejects.toThrow(/Plane HTTP 404/);
  });

  it('api key does not appear in thrown error message', async () => {
    const transport: Transport = async () => fakeResponse(403, null);
    const client = makeClient(transport);

    await expect(client.request('GET', '/x/')).rejects.toSatisfy(
      (e: Error) => !e.message.includes('k'),
    );
  });

  it('returns undefined for 204', async () => {
    const transport: Transport = async () => fakeResponse(204, null);
    const client = makeClient(transport);

    const result = await client.request('DELETE', '/work-items/x/');
    expect(result).toBeUndefined();
  });

  it('exhausting retries on persistent 500 throws with Plane HTTP 500 in message', async () => {
    // With maxRetries=1: attempt 0 → 500 (retryable, retry), attempt 1 → 500 (no more retries, >=400 branch)
    const transport: Transport = async () => fakeResponse(500, null);
    const client = makeClient(transport, { maxRetries: 1 });

    await expect(client.request('GET', '/x/')).rejects.toThrow(/Plane HTTP 500/);
  });
});

describe('PlaneClient.getAllPages', () => {
  it('cursor pagination: fetches all pages and passes cursor in second call', async () => {
    let callCount = 0;
    let secondCallUrl = '';

    const transport: Transport = async (url) => {
      callCount++;
      if (callCount === 1) {
        return fakeResponse(200, {
          results: [1, 2],
          next_page_results: true,
          next_cursor: 'c1',
        });
      }
      secondCallUrl = url;
      return fakeResponse(200, {
        results: [3],
        next_page_results: false,
      });
    };

    const client = makeClient(transport);
    const result = await client.getAllPages('/issues/');

    expect(result).toEqual([1, 2, 3]);
    expect(callCount).toBe(2);

    const u = new URL(secondCallUrl);
    expect(u.searchParams.get('cursor')).toBe('c1');
    expect(u.searchParams.get('per_page')).toBe('100');
  });

  it('tolerates a bare array response', async () => {
    const transport: Transport = async () => fakeResponse(200, [{ id: 'a' }]);
    const client = makeClient(transport);

    const result = await client.getAllPages('/states/');
    expect(result).toEqual([{ id: 'a' }]);
  });

  it('tolerates {results:[...]} with no cursor fields', async () => {
    const transport: Transport = async () =>
      fakeResponse(200, { results: [{ id: 'b' }, { id: 'c' }] });
    const client = makeClient(transport);

    const result = await client.getAllPages('/labels/');
    expect(result).toEqual([{ id: 'b' }, { id: 'c' }]);
  });
});
