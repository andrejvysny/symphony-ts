import { describe, expect, it, vi } from 'vitest';
import { fetchClaudeUsageLimits, getClaudeUsageLimits } from './usage-limits.js';

/** Build a minimal fetch stub returning the given JSON body / status. */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const OK_BODY = {
  five_hour: { utilization: 18, resets_at: '2026-06-19T20:00:00Z' },
  seven_day: { utilization: 74, resets_at: '2026-06-24T14:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 40, resets_at: '2026-06-24T14:00:00Z' },
};

describe('fetchClaudeUsageLimits', () => {
  it('parses a 200 body into camelCase windows', async () => {
    const res = await fetchClaudeUsageLimits('tok', { fetchImpl: fakeFetch(OK_BODY) });
    expect(res.available).toBe(true);
    if (!res.available) throw new Error('unreachable');
    expect(res.fiveHour).toEqual({ utilization: 18, resetsAt: '2026-06-19T20:00:00Z' });
    expect(res.sevenDay.utilization).toBe(74);
    expect(res.fetchedAt).toMatch(/^\d{4}-/);
  });

  it('omits null opus/sonnet sub-limits', async () => {
    const res = await fetchClaudeUsageLimits('tok', { fetchImpl: fakeFetch(OK_BODY) });
    if (!res.available) throw new Error('unreachable');
    expect(res.sevenDayOpus).toBeUndefined();
    expect(res.sevenDaySonnet).toEqual({ utilization: 40, resetsAt: '2026-06-24T14:00:00Z' });
  });

  it('maps a non-200 to http_<status>', async () => {
    const res = await fetchClaudeUsageLimits('tok', {
      fetchImpl: fakeFetch({}, { ok: false, status: 429 }),
    });
    expect(res).toEqual({ available: false, reason: 'http_429' });
  });

  it('maps a network throw to network', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const res = await fetchClaudeUsageLimits('tok', { fetchImpl });
    expect(res).toEqual({ available: false, reason: 'network' });
  });

  it('maps a TimeoutError to timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    const res = await fetchClaudeUsageLimits('tok', { fetchImpl });
    expect(res).toEqual({ available: false, reason: 'timeout' });
  });

  it('rejects a malformed body shape', async () => {
    const res = await fetchClaudeUsageLimits('tok', { fetchImpl: fakeFetch({ nope: 1 }) });
    expect(res).toEqual({ available: false, reason: 'shape' });
  });
});

describe('getClaudeUsageLimits', () => {
  it('returns no_token when the reader yields null', async () => {
    const res = await getClaudeUsageLimits({
      readToken: async () => null,
      fetchImpl: fakeFetch(OK_BODY),
    });
    expect(res).toEqual({ available: false, reason: 'no_token' });
  });

  it('fetches when a token is present', async () => {
    const res = await getClaudeUsageLimits({
      readToken: async () => 'tok',
      fetchImpl: fakeFetch(OK_BODY),
    });
    expect(res.available).toBe(true);
  });
});
