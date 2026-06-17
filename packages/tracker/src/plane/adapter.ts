import { randomUUID } from 'node:crypto';
import type { IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type {
  ActivityReader,
  BoardReader,
  CreateIssueInput,
  IssueActivity,
  IssueComment,
  IssueCreator,
  IssuePatch,
  IssueWriter,
  LabelInfo,
  Tracker,
  UploadInput,
  WorkflowStateInfo,
} from '../tracker.js';
import type { Transport } from '../http/transport.js';
import { PlaneClient } from './client.js';
import {
  intToPlanePriority,
  normalizeIssue,
  type NormalizeContext,
  type RawPlaneIssue,
} from './normalize.js';

/** Work-item collection path. Plane deprecated `/issues/` for `/work-items/` (EOS 2026-03-31). */
const WORK_ITEMS = '/work-items/';

export interface PlaneTrackerOptions {
  /** Base instance URL, e.g. `http://localhost`. */
  endpoint: string;
  apiKey: string;
  workspaceSlug: string;
  projectId: string;
  activeStates: string[];
  /** Injectable transport (tests). */
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
}

interface RawPlaneState {
  id: string;
  name?: string;
  color?: string;
  group?: string;
  sequence?: number;
}

interface RawPlaneLabel {
  id: string;
  name?: string;
}

interface RawPlaneProject {
  identifier?: string;
}

interface RawPlaneActivity {
  created_at?: string;
  field?: string | null;
  verb?: string;
  old_value?: string | null;
  new_value?: string | null;
}

interface RawPlaneComment {
  created_at?: string;
  comment_stripped?: string | null;
  comment_html?: string | null;
}

/** Strip HTML tags to plain text + decode common entities (Plane comments are HTML). */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface PlaneUploadCredential {
  /** S3-style presigned POST form. */
  upload_data?: { url?: string; fields?: Record<string, string> };
  /** Attachment record id (name varies by version — we read several). */
  asset_id?: string;
  id?: string;
  attachment?: { id?: string };
}

/** Escape a plain string and wrap it as a single Plane comment/description HTML paragraph. */
function toHtml(text: string): string {
  if (/^\s*</.test(text)) return text; // already HTML
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc}</p>`;
}

const PENDING_PREFIX = 'plane-pending:';

/**
 * Plane (Community Edition) tracker adapter over the REST `/api/v1/`. The orchestrator only
 * reads through {@link Tracker}; the writer/creator capabilities back the CLI + dashboard.
 *
 * State names ↔ UUIDs and label names are joined client-side via `/states/` and `/labels/`,
 * fetched once and memoized for the adapter's lifetime (the tracker is built once at startup).
 */
export class PlaneTracker
  implements Tracker, IssueCreator, BoardReader, IssueWriter, ActivityReader
{
  readonly kind = 'plane';
  private readonly client: PlaneClient;
  private readonly activeStates: Set<string>;
  /** Bytes staged by uploadFile, attached to an issue later by attachToIssue (deferred-attach). */
  private readonly pending = new Map<string, UploadInput>();

  private statesCache?: Promise<WorkflowStateInfo[]>;
  private labelsCache?: Promise<Map<string, string>>;
  private projectIdCache?: Promise<string>;

  constructor(private readonly opts: PlaneTrackerOptions) {
    this.client = new PlaneClient({
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      workspaceSlug: opts.workspaceSlug,
      projectId: opts.projectId,
      ...(opts.transport ? { transport: opts.transport } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    this.activeStates = new Set(opts.activeStates);
  }

  // ---- cached lookups (memoized for adapter lifetime) ----

  private states(): Promise<WorkflowStateInfo[]> {
    return (this.statesCache ??= this.client.getAllPages<RawPlaneState>('/states/').then((rows) =>
      rows
        .map((s) => ({
          id: s.id,
          name: s.name ?? '',
          type: s.group ?? '',
          position: s.sequence ?? 0,
          ...(s.color !== undefined ? { color: s.color } : {}),
        }))
        .sort((a, b) => a.position - b.position),
    ));
  }

  private async stateNameById(): Promise<Map<string, string>> {
    return new Map((await this.states()).map((s) => [s.id, s.name]));
  }

  private async stateIdByName(): Promise<Map<string, string>> {
    return new Map((await this.states()).map((s) => [s.name, s.id]));
  }

  private labelNameById(): Promise<Map<string, string>> {
    return (this.labelsCache ??= this.client
      .getAllPages<RawPlaneLabel>('/labels/')
      .then((rows) => new Map(rows.map((l) => [l.id, (l.name ?? '').toLowerCase()]))));
  }

  private projectIdentifier(): Promise<string> {
    return (this.projectIdCache ??= this.client
      .request<RawPlaneProject>('GET', '/')
      .then((p) => p?.identifier ?? ''));
  }

  private async context(): Promise<NormalizeContext> {
    const [stateNameById, labelNameById, projectIdentifier] = await Promise.all([
      this.stateNameById(),
      this.labelNameById(),
      this.projectIdentifier(),
    ]);
    return {
      stateNameById,
      labelNameById,
      projectIdentifier,
      endpoint: this.opts.endpoint.replace(/\/+$/, ''),
      workspaceSlug: this.opts.workspaceSlug,
      projectId: this.opts.projectId,
    };
  }

  // ---- Tracker (read, orchestrator path) ----

  async fetchCandidateIssues(): Promise<NormalizedIssue[]> {
    return this.fetchFilteredBy((s) => this.activeStates.has(s));
  }

  async fetchIssuesByStates(states: string[]): Promise<NormalizedIssue[]> {
    const set = new Set(states);
    return this.fetchFilteredBy((s) => set.has(s));
  }

  /** Plane has no reliable `?state=` filter, so fetch all and filter client-side by state name. */
  private async fetchFilteredBy(keep: (stateName: string) => boolean): Promise<NormalizedIssue[]> {
    const [rows, ctx] = await Promise.all([
      this.client.getAllPages<RawPlaneIssue>(WORK_ITEMS),
      this.context(),
    ]);
    return rows.map((r) => normalizeIssue(r, ctx)).filter((i) => keep(i.state));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]> {
    if (ids.length === 0) return [];
    const ctx = await this.context();
    const out: IssueStateRef[] = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await this.client.request<RawPlaneIssue>('GET', `${WORK_ITEMS}${id}/`);
          const norm = normalizeIssue(raw, ctx);
          out.push({ id: norm.id, identifier: norm.identifier, state: norm.state });
        } catch {
          // Missing ids are omitted (matches the Tracker contract).
        }
      }),
    );
    return out;
  }

  // ---- BoardReader (operator path) ----

  async fetchAllIssues(): Promise<NormalizedIssue[]> {
    const [rows, ctx] = await Promise.all([
      this.client.getAllPages<RawPlaneIssue>(WORK_ITEMS),
      this.context(),
    ]);
    return rows.map((r) => normalizeIssue(r, ctx));
  }

  async listWorkflowStates(): Promise<WorkflowStateInfo[]> {
    return (await this.states()).map((s) => ({ ...s }));
  }

  async listLabels(): Promise<LabelInfo[]> {
    return [...(await this.labelNameById())].map(([id, name]) => ({ id, name }));
  }

  // ---- IssueWriter (operator path) ----

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.client.request('PATCH', `${WORK_ITEMS}${issueId}/`, { state: stateId });
  }

  async updateIssue(issueId: string, patch: IssuePatch): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body['name'] = patch.title;
    if (patch.description !== undefined)
      body['description_html'] = patch.description ? toHtml(patch.description) : '<p></p>';
    // Update sends an explicit 'none' to clear (intToPlanePriority returns undefined for none).
    if (patch.priority !== undefined)
      body['priority'] = intToPlanePriority(patch.priority ?? undefined) ?? 'none';
    if (patch.labelIds !== undefined) body['labels'] = patch.labelIds;
    if (Object.keys(body).length === 0) return;
    await this.client.request('PATCH', `${WORK_ITEMS}${issueId}/`, body);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.request('POST', `${WORK_ITEMS}${issueId}/comments/`, {
      comment_html: toHtml(body),
    });
  }

  async uploadFile(input: UploadInput): Promise<{ assetUrl: string }> {
    // Plane attachments are issue-scoped, but uploadFile runs before the issue exists.
    // Stage the bytes and hand back a sentinel; attachToIssue performs the real upload.
    const token = randomUUID();
    this.pending.set(token, input);
    return { assetUrl: `${PENDING_PREFIX}${token}` };
  }

  async attachToIssue(issueId: string, url: string, title?: string): Promise<void> {
    if (url.startsWith(PENDING_PREFIX)) {
      const token = url.slice(PENDING_PREFIX.length);
      const file = this.pending.get(token);
      if (!file) return;
      this.pending.delete(token);
      await this.uploadAttachment(issueId, file);
      return;
    }
    // No native attach-by-external-URL in Plane v1 — record the link as a comment.
    await this.addComment(issueId, `<p><a href="${url}">${title ?? url}</a></p>`);
  }

  /** Plane's 3-step presigned attachment upload (verify route/fields against the live instance). */
  private async uploadAttachment(issueId: string, file: UploadInput): Promise<void> {
    const cred = await this.client.request<PlaneUploadCredential>(
      'POST',
      `${WORK_ITEMS}${issueId}/issue-attachments/`,
      { name: file.filename, size: file.data.length, type: file.contentType },
    );
    const uploadUrl = cred?.upload_data?.url;
    if (!uploadUrl) throw new Error('Plane attachment: no presigned upload URL returned');

    const form = new FormData();
    for (const [k, v] of Object.entries(cred.upload_data?.fields ?? {})) form.append(k, v);
    form.append(
      'file',
      new Blob([new Uint8Array(file.data)], { type: file.contentType }),
      file.filename,
    );
    // Use global fetch (not undici.request) so the global FormData type lines up.
    const put = await fetch(uploadUrl, { method: 'POST', body: form });
    if (put.status >= 300) {
      throw new Error(`Plane attachment upload failed (HTTP ${put.status})`);
    }

    const assetId = cred.asset_id ?? cred.id ?? cred.attachment?.id;
    if (assetId) {
      await this.client.request('PATCH', `${WORK_ITEMS}${issueId}/issue-attachments/${assetId}/`, {
        is_uploaded: true,
      });
    }
  }

  // ---- ActivityReader (history + comments, detail path) ----

  async fetchActivity(issueId: string): Promise<IssueActivity[]> {
    const rows = await this.client.getAllPages<RawPlaneActivity>(
      `${WORK_ITEMS}${issueId}/activities/`,
    );
    return rows
      .map((a) => ({
        at: a.created_at ?? '',
        field: a.field ?? null,
        verb: a.verb ?? '',
        oldValue: a.old_value ?? null,
        newValue: a.new_value ?? null,
      }))
      .sort((x, y) => x.at.localeCompare(y.at));
  }

  async fetchComments(issueId: string): Promise<IssueComment[]> {
    const rows = await this.client.getAllPages<RawPlaneComment>(
      `${WORK_ITEMS}${issueId}/comments/`,
    );
    return rows
      .map((c) => ({
        at: c.created_at ?? '',
        body: c.comment_stripped ?? stripHtml(c.comment_html ?? ''),
      }))
      .sort((x, y) => x.at.localeCompare(y.at));
  }

  // ---- IssueCreator (CLI + dashboard) ----

  async createIssue(input: CreateIssueInput): Promise<NormalizedIssue> {
    let stateId = input.stateId;
    if (!stateId && input.stateName) {
      stateId = (await this.stateIdByName()).get(input.stateName);
      if (!stateId) throw new Error(`workflow state "${input.stateName}" not found in project`);
    }

    const parts: string[] = [];
    if (input.description) parts.push(toHtml(input.description));
    for (const a of input.attachments ?? []) {
      if (a.url.startsWith(PENDING_PREFIX)) continue; // staged bytes become native attachments
      parts.push(`<p><a href="${a.url}">${a.title}</a></p>`);
    }

    const body: Record<string, unknown> = { name: input.title };
    if (parts.length) body['description_html'] = parts.join('');
    if (stateId) body['state'] = stateId;
    const priority = intToPlanePriority(input.priority);
    if (priority !== undefined) body['priority'] = priority;

    const created = await this.client.request<RawPlaneIssue>('POST', WORK_ITEMS, body);
    return normalizeIssue(created, await this.context());
  }
}
