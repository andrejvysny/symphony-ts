import { request } from 'undici';
import type { IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type {
  BoardReader,
  CreateIssueInput,
  IssueCreator,
  IssueWriter,
  Tracker,
  UploadInput,
  WorkflowStateInfo,
} from '../tracker.js';
import { LinearClient, type Transport } from './client.js';
import { normalizeIssue, type RawLinearIssue } from './normalize.js';
import {
  ALL_ISSUES_BY_PROJECT,
  ATTACHMENT_CREATE,
  CREATE_COMMENT,
  CREATE_ISSUE,
  FILE_UPLOAD,
  ISSUES_BY_PROJECT_AND_STATES,
  ISSUE_STATES_BY_IDS,
  UPDATE_ISSUE_STATE,
  WORKFLOW_STATES_BY_PROJECT,
} from './queries.js';

export type HttpPut = (
  url: string,
  headers: Record<string, string>,
  body: Buffer,
) => Promise<{ statusCode: number }>;

export interface LinearTrackerOptions {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  /** Injectable GraphQL transport (tests). */
  transport?: Transport;
  /** Injectable asset PUT (tests); defaults to undici. */
  httpPut?: HttpPut;
}

interface IssueConnection {
  issues?: { nodes?: RawLinearIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } };
}

const defaultHttpPut: HttpPut = async (url, headers, body) => {
  const res = await request(url, { method: 'PUT', headers, body });
  await res.body.dump();
  return { statusCode: res.statusCode };
};

export class LinearTracker implements Tracker, IssueCreator, BoardReader, IssueWriter {
  readonly kind = 'linear';
  private readonly client: LinearClient;
  private readonly httpPut: HttpPut;

  constructor(private readonly opts: LinearTrackerOptions) {
    this.client = new LinearClient({
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      ...(opts.transport ? { transport: opts.transport } : {}),
    });
    this.httpPut = opts.httpPut ?? defaultHttpPut;
  }

  private async paginate(query: string, vars: Record<string, unknown>): Promise<NormalizedIssue[]> {
    const out: NormalizedIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const res = await this.client.graphql(query, { ...vars, after: after ?? null });
      if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
      const conn = (res.data as IssueConnection)?.issues;
      for (const node of conn?.nodes ?? []) out.push(normalizeIssue(node));
      if (conn?.pageInfo?.hasNextPage && conn.pageInfo.endCursor) after = conn.pageInfo.endCursor;
      else break;
    }
    return out;
  }

  // ---- Tracker (read, orchestrator path) ----

  async fetchCandidateIssues(): Promise<NormalizedIssue[]> {
    return this.paginate(ISSUES_BY_PROJECT_AND_STATES, {
      slug: this.opts.projectSlug,
      states: this.opts.activeStates,
    });
  }

  async fetchIssuesByStates(states: string[]): Promise<NormalizedIssue[]> {
    return this.paginate(ISSUES_BY_PROJECT_AND_STATES, { slug: this.opts.projectSlug, states });
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]> {
    if (ids.length === 0) return [];
    const res = await this.client.graphql(ISSUE_STATES_BY_IDS, { ids });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const nodes = (res.data as IssueConnection)?.issues?.nodes ?? [];
    return nodes.map((n) => ({ id: n.id, identifier: n.identifier, state: n.state?.name ?? '' }));
  }

  // ---- BoardReader (operator path) ----

  async fetchAllIssues(): Promise<NormalizedIssue[]> {
    return this.paginate(ALL_ISSUES_BY_PROJECT, { slug: this.opts.projectSlug });
  }

  async listWorkflowStates(): Promise<WorkflowStateInfo[]> {
    const res = await this.client.graphql(WORKFLOW_STATES_BY_PROJECT, {
      slug: this.opts.projectSlug,
    });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const nodes =
      (res.data as { workflowStates?: { nodes?: WorkflowStateInfo[] } })?.workflowStates?.nodes ??
      [];
    return [...nodes].sort((a, b) => a.position - b.position);
  }

  // ---- IssueWriter (operator path) ----

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const res = await this.client.graphql(UPDATE_ISSUE_STATE, { id: issueId, stateId });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const ok = (res.data as { issueUpdate?: { success?: boolean } })?.issueUpdate?.success;
    if (!ok) throw new Error('Linear issueUpdate failed');
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const res = await this.client.graphql(CREATE_COMMENT, { issueId, body });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
  }

  async uploadFile(input: UploadInput): Promise<{ assetUrl: string }> {
    const res = await this.client.graphql(FILE_UPLOAD, {
      contentType: input.contentType,
      filename: input.filename,
      size: input.data.length,
    });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const upload = (
      res.data as {
        fileUpload?: {
          success?: boolean;
          uploadFile?: {
            uploadUrl: string;
            assetUrl: string;
            headers?: Array<{ key: string; value: string }>;
          };
        };
      }
    )?.fileUpload;
    if (!upload?.success || !upload.uploadFile) throw new Error('Linear fileUpload failed');

    const headers: Record<string, string> = { 'content-type': input.contentType };
    for (const h of upload.uploadFile.headers ?? []) headers[h.key] = h.value;
    // Must PUT server-side (Linear CSP blocks browser uploads).
    const put = await this.httpPut(upload.uploadFile.uploadUrl, headers, input.data);
    if (put.statusCode >= 300) throw new Error(`asset upload PUT failed (HTTP ${put.statusCode})`);
    return { assetUrl: upload.uploadFile.assetUrl };
  }

  async attachToIssue(issueId: string, url: string, title?: string): Promise<void> {
    const res = await this.client.graphql(ATTACHMENT_CREATE, { issueId, url, title: title ?? url });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
  }

  // ---- IssueCreator ----

  async createIssue(input: CreateIssueInput): Promise<NormalizedIssue> {
    const team = await this.resolveTeam();
    let stateId = input.stateId;
    if (!stateId && input.stateName) {
      stateId = team.states.find((s) => s.name === input.stateName)?.id;
      if (!stateId) throw new Error(`workflow state "${input.stateName}" not found on team`);
    }

    let description = input.description ?? '';
    if (input.attachments?.length) {
      const md = input.attachments.map((a) => `![${a.title}](${a.url})`).join('\n');
      description = description ? `${description}\n\n${md}` : md;
    }

    const issueInput: Record<string, unknown> = { teamId: team.teamId, title: input.title };
    if (description) issueInput['description'] = description;
    if (input.priority !== undefined) issueInput['priority'] = input.priority;
    if (stateId) issueInput['stateId'] = stateId;

    const res = await this.client.graphql(CREATE_ISSUE, { input: issueInput });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const created = (res.data as { issueCreate?: { success?: boolean; issue?: RawLinearIssue } })
      ?.issueCreate;
    if (!created?.success || !created.issue) throw new Error('Linear issueCreate failed');
    return normalizeIssue(created.issue);
  }

  private async resolveTeam(): Promise<{
    teamId: string;
    states: Array<{ id: string; name: string }>;
  }> {
    const res = await this.client.graphql(
      `query SymphonyProjectTeam($slug: String!) {
        projects(first: 1, filter: { slugId: { eq: $slug } }) {
          nodes { id teams { nodes { id states { nodes { id name } } } } }
        }
      }`,
      { slug: this.opts.projectSlug },
    );
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const project = (
      res.data as {
        projects?: {
          nodes?: Array<{
            teams?: {
              nodes?: Array<{
                id: string;
                states?: { nodes?: Array<{ id: string; name: string }> };
              }>;
            };
          }>;
        };
      }
    )?.projects?.nodes?.[0];
    const team = project?.teams?.nodes?.[0];
    if (!team) throw new Error(`no team found for project slug ${this.opts.projectSlug}`);
    return { teamId: team.id, states: team.states?.nodes ?? [] };
  }
}
