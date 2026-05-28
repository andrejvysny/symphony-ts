import { describe, expect, it, vi } from 'vitest';
import { LinearClient, type Transport, type TransportResponse } from './client.js';

function resp(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): TransportResponse {
  return {
    statusCode,
    headers,
    json: async () => body,
    dump: async () => {},
  };
}

describe('LinearClient retry/backoff', () => {
  it('retries on 429 then succeeds', async () => {
    const calls: number[] = [];
    const transport: Transport = vi.fn(async () => {
      calls.push(1);
      return calls.length < 3
        ? resp(429, {}, { 'retry-after': '0' })
        : resp(200, { data: { ok: true } });
    });
    const client = new LinearClient({
      endpoint: 'https://x',
      apiKey: 'k',
      transport,
      sleep: async () => {},
    });
    const res = await client.graphql('query { ok }');
    expect(calls.length).toBe(3);
    expect(res.data).toEqual({ ok: true });
  });

  it('retries on 5xx', async () => {
    let n = 0;
    const transport: Transport = async () => {
      n += 1;
      return n < 2 ? resp(503, {}) : resp(200, { data: {} });
    };
    const client = new LinearClient({
      endpoint: 'https://x',
      apiKey: 'k',
      transport,
      sleep: async () => {},
    });
    await client.graphql('query { a }');
    expect(n).toBe(2);
  });

  it('throws after exhausting retries', async () => {
    const transport: Transport = async () => resp(429, {});
    const client = new LinearClient({
      endpoint: 'https://x',
      apiKey: 'k',
      maxRetries: 2,
      transport,
      sleep: async () => {},
    });
    await expect(client.graphql('query { a }')).rejects.toThrow(/Linear HTTP 429/);
  });

  it('does not retry a normal GraphQL error response', async () => {
    let n = 0;
    const transport: Transport = async () => {
      n += 1;
      return resp(200, { errors: [{ message: 'bad' }] });
    };
    const client = new LinearClient({
      endpoint: 'https://x',
      apiKey: 'k',
      transport,
      sleep: async () => {},
    });
    const res = await client.graphql('query { a }');
    expect(n).toBe(1);
    expect(res.errors?.[0]?.message).toBe('bad');
  });
});
