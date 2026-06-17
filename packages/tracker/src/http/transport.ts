import { request } from 'undici';

/** Minimal HTTP response surface used by tracker clients (injectable for tests). */
export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json: () => Promise<unknown>;
  /** Drain/discard the body to free the socket when we're going to retry. */
  dump: () => Promise<void>;
}

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
) => Promise<TransportResponse>;

export const defaultTransport: Transport = async (url, init) => {
  const res = await request(url, {
    method: init.method as 'GET',
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    headersTimeout: init.timeoutMs,
    bodyTimeout: init.timeoutMs,
  });
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    json: () => res.body.json(),
    dump: async () => {
      await res.body.dump();
    },
  };
};

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Transient statuses worth retrying: rate-limit, request-timeout, and 5xx. */
export function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Backoff with jitter: min(500·2^attempt, 30s); Retry-After header wins when present. */
export function backoffMs(attempt: number, headers: TransportResponse['headers']): number {
  const ra = headers['retry-after'];
  const raStr = Array.isArray(ra) ? ra[0] : ra;
  if (raStr) {
    const secs = Number(raStr);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
  }
  const base = Math.min(500 * 2 ** attempt, 30_000);
  return base + Math.floor(base * 0.2 * Math.random());
}
