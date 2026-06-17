import {
  backoffMs,
  defaultSleep,
  defaultTransport,
  isRetryable,
  type Transport,
} from '../http/transport.js';

export type RestMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface PlaneClientOptions {
  /** Base instance URL, e.g. `http://localhost` (NO trailing `/api/v1`). */
  endpoint: string;
  apiKey: string;
  workspaceSlug: string;
  projectId: string;
  timeoutMs?: number;
  /** Max retry attempts for 429/408/5xx (default 4). */
  maxRetries?: number;
  /** Injectable for tests. */
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
}

type QueryParams = Record<string, string | string[] | undefined>;

interface CursorPage {
  results?: unknown[];
  next_cursor?: string | null;
  next_page_results?: boolean;
}

function buildQuery(query?: QueryParams): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(k, item);
    else sp.append(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Plane REST client (Plane CE `/api/v1/`): `X-API-Key` auth, 30s timeout, retry on
 * 429/408/5xx with backoff. All paths are relative to the configured project base
 * `{endpoint}/api/v1/workspaces/{slug}/projects/{id}`.
 */
export class PlaneClient {
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  /** `${endpoint}/api/v1/workspaces/{slug}/projects/{id}` — every `path` is relative to this. */
  readonly base: string;

  constructor(private readonly opts: PlaneClientOptions) {
    this.transport = opts.transport ?? defaultTransport;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const root = opts.endpoint.replace(/\/+$/, '');
    this.base = `${root}/api/v1/workspaces/${opts.workspaceSlug}/projects/${opts.projectId}`;
  }

  /**
   * One REST call. `path` is relative to the project base and must start with `/`.
   * Returns parsed JSON, or `undefined` for empty/204 bodies. Throws `Plane HTTP NNN`
   * on >=400 (never leaks the api key or request body).
   */
  async request<T = unknown>(
    method: RestMethod,
    path: string,
    body?: unknown,
    query?: QueryParams,
  ): Promise<T> {
    const url = this.base + path + buildQuery(query);
    const hasBody = body !== undefined && method !== 'GET';
    const headers: Record<string, string> = {
      'x-api-key': this.opts.apiKey,
      accept: 'application/json',
    };
    if (hasBody) headers['content-type'] = 'application/json';
    const init = {
      method,
      headers,
      timeoutMs: this.timeoutMs,
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    };

    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.transport(url, init);
      lastStatus = res.statusCode;

      if (isRetryable(res.statusCode) && attempt < this.maxRetries) {
        await res.dump();
        await this.sleep(backoffMs(attempt, res.headers));
        continue;
      }
      if (res.statusCode >= 400) {
        await res.dump();
        throw new Error(`Plane HTTP ${res.statusCode}`);
      }
      if (res.statusCode === 204) {
        await res.dump();
        return undefined as T;
      }
      try {
        return (await res.json()) as T;
      } catch {
        // A few mutations return 200 with an empty body — treat as no content.
        return undefined as T;
      }
    }

    throw new Error(
      `Plane request failed after ${this.maxRetries} retries (last status ${lastStatus})`,
    );
  }

  /**
   * Fetch every page of a list endpoint. Tolerates three response shapes:
   * cursor-paginated `{results, next_cursor, next_page_results}`, a non-cursor
   * `{results}`, or a bare array (some endpoints, e.g. `/states/`, `/labels/`).
   */
  async getAllPages<T = unknown>(path: string, query?: QueryParams): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const q: QueryParams = {
        ...(query ?? {}),
        per_page: '100',
        ...(cursor !== undefined ? { cursor } : {}),
      };
      const page = await this.request<unknown>('GET', path, undefined, q);
      if (Array.isArray(page)) {
        out.push(...(page as T[]));
        break;
      }
      const p = (page ?? {}) as CursorPage;
      for (const item of p.results ?? []) out.push(item as T);
      if (
        p.next_page_results === true &&
        typeof p.next_cursor === 'string' &&
        p.next_cursor.length > 0
      ) {
        cursor = p.next_cursor;
      } else {
        break;
      }
    }
    return out;
  }
}
