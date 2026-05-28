import { request } from 'undici';

export interface GraphqlResult {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json: () => Promise<unknown>;
  /** Drain/discard the body to free the socket when we're going to retry. */
  dump: () => Promise<void>;
}

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; timeoutMs: number },
) => Promise<TransportResponse>;

export interface LinearClientOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  /** Max retry attempts for 429/5xx (default 4). */
  maxRetries?: number;
  /** Injectable for tests. */
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
}

const defaultTransport: Transport = async (url, init) => {
  const res = await request(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
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

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Backoff with jitter: min(500·2^attempt, 30s); Retry-After header wins when present. */
function backoffMs(attempt: number, headers: TransportResponse['headers']): number {
  const ra = headers['retry-after'];
  const raStr = Array.isArray(ra) ? ra[0] : ra;
  if (raStr) {
    const secs = Number(raStr);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
  }
  const base = Math.min(500 * 2 ** attempt, 30_000);
  return base + Math.floor(base * 0.2 * Math.random());
}

/** Linear GraphQL client (SPEC §11.2): Authorization header, 30s timeout, retry on 429/5xx. */
export class LinearClient {
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: LinearClientOptions) {
    this.transport = opts.transport ?? defaultTransport;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async graphql(query: string, variables: Record<string, unknown> = {}): Promise<GraphqlResult> {
    const body = JSON.stringify({ query, variables });
    let lastStatus = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.transport(this.opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: this.opts.apiKey },
        body,
        timeoutMs: this.timeoutMs,
      });
      lastStatus = res.statusCode;

      if (isRetryable(res.statusCode) && attempt < this.maxRetries) {
        await res.dump();
        await this.sleep(backoffMs(attempt, res.headers));
        continue;
      }

      const json = (await res.json()) as GraphqlResult;
      // Never include the API key or request body in errors.
      if (res.statusCode >= 400 && !json.errors) {
        throw new Error(`Linear HTTP ${res.statusCode}`);
      }
      return json;
    }

    throw new Error(
      `Linear request failed after ${this.maxRetries} retries (last status ${lastStatus})`,
    );
  }
}
