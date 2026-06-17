import {
  backoffMs,
  defaultSleep,
  defaultTransport,
  isRetryable,
  type Transport,
} from '../http/transport.js';
import type { RestMethod } from './client.js';

export interface PlaneWorkspaceClientOptions {
  /** Base instance URL, e.g. `http://localhost` (NO trailing `/api/v1`). */
  endpoint: string;
  apiKey: string;
  workspaceSlug: string;
  timeoutMs?: number;
  maxRetries?: number;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  identifier: string;
}

interface RawWorkspaceProject {
  id?: string;
  name?: string;
  identifier?: string;
}

interface RawState {
  name?: string;
}

interface CursorPage {
  results?: unknown[];
  next_cursor?: string | null;
  next_page_results?: boolean;
}

/** Plane state group buckets; the new-project seeder maps each workflow state name to one. */
const GROUP_BY_NAME: Record<string, string> = {
  backlog: 'backlog',
  todo: 'unstarted',
  'in progress': 'started',
  rework: 'started',
  merging: 'started',
  'human review': 'started',
  'in review': 'started',
  done: 'completed',
  closed: 'completed',
  merged: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  duplicate: 'cancelled',
};

function groupForState(name: string): string {
  return GROUP_BY_NAME[name.trim().toLowerCase()] ?? 'started';
}

/**
 * Workspace-scoped Plane REST client (base `…/api/v1/workspaces/{slug}`). Complements the
 * project-scoped {@link PlaneClient}: lists/creates projects for the dashboard project switcher.
 * Shares the same `X-API-Key` auth + retry/backoff transport.
 */
export class PlaneWorkspaceClient {
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  /** `${endpoint}/api/v1/workspaces/{slug}` — every `path` is relative to this. */
  readonly base: string;

  constructor(private readonly opts: PlaneWorkspaceClientOptions) {
    this.transport = opts.transport ?? defaultTransport;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.base = `${opts.endpoint.replace(/\/+$/, '')}/api/v1/workspaces/${opts.workspaceSlug}`;
  }

  async request<T = unknown>(method: RestMethod, path: string, body?: unknown): Promise<T> {
    const url = this.base + path;
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
        return undefined as T;
      }
    }
    throw new Error(
      `Plane request failed after ${this.maxRetries} retries (last status ${lastStatus})`,
    );
  }

  /** Fetch every page of a list endpoint (tolerant of bare-array + cursor shapes). */
  private async getAllPages<T = unknown>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const q = `${sep}per_page=100${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await this.request<unknown>('GET', path + q);
      if (Array.isArray(page)) {
        out.push(...(page as T[]));
        break;
      }
      const p = (page ?? {}) as CursorPage;
      for (const item of p.results ?? []) out.push(item as T);
      if (p.next_page_results === true && typeof p.next_cursor === 'string' && p.next_cursor) {
        cursor = p.next_cursor;
      } else {
        break;
      }
    }
    return out;
  }

  async listProjects(): Promise<WorkspaceProject[]> {
    const rows = await this.getAllPages<RawWorkspaceProject>('/projects/');
    return rows
      .filter((r): r is RawWorkspaceProject & { id: string } => typeof r.id === 'string')
      .map((r) => ({ id: r.id, name: r.name ?? '', identifier: r.identifier ?? '' }));
  }

  async createProject(input: { name: string; identifier: string }): Promise<WorkspaceProject> {
    const created = await this.request<RawWorkspaceProject>('POST', '/projects/', {
      name: input.name,
      identifier: input.identifier,
    });
    if (!created?.id) throw new Error('Plane createProject: no project id returned');
    return {
      id: created.id,
      name: created.name ?? input.name,
      identifier: created.identifier ?? input.identifier,
    };
  }

  /**
   * Best-effort: create any of `names` that the freshly-created project doesn't already have as a
   * workflow state (Plane auto-creates defaults like Todo/In Progress/Done). Per-state failures are
   * swallowed so one bad name never aborts project creation.
   */
  async seedStates(
    projectId: string,
    names: string[],
  ): Promise<{ created: string[]; skipped: string[] }> {
    let existing = new Set<string>();
    try {
      const rows = await this.getAllPages<RawState>(`/projects/${projectId}/states/`);
      existing = new Set(rows.map((s) => (s.name ?? '').trim().toLowerCase()));
    } catch {
      // If we can't list states, attempt to create all (Plane rejects dupes harmlessly per try/catch).
    }
    const created: string[] = [];
    const skipped: string[] = [];
    for (const name of names) {
      if (existing.has(name.trim().toLowerCase())) {
        skipped.push(name);
        continue;
      }
      try {
        await this.request('POST', `/projects/${projectId}/states/`, {
          name,
          group: groupForState(name),
        });
        created.push(name);
      } catch {
        skipped.push(name);
      }
    }
    return { created, skipped };
  }
}
