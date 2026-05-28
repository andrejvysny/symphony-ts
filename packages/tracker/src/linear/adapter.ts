import type { IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type { IssueCreator, Tracker } from '../tracker.js';
import { LinearClient } from './client.js';
import { normalizeIssue, type RawLinearIssue } from './normalize.js';
import { CREATE_ISSUE, ISSUES_BY_PROJECT_AND_STATES, ISSUE_STATES_BY_IDS } from './queries.js';

export interface LinearTrackerOptions {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
}

interface IssueConnection {
  issues?: { nodes?: RawLinearIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } };
}

export class LinearTracker implements Tracker, IssueCreator {
  readonly kind = 'linear';
  private readonly client: LinearClient;

  constructor(private readonly opts: LinearTrackerOptions) {
    this.client = new LinearClient({ endpoint: opts.endpoint, apiKey: opts.apiKey });
  }

  private async paginate(query: string, states: string[]): Promise<NormalizedIssue[]> {
    const out: NormalizedIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const res = await this.client.graphql(query, {
        slug: this.opts.projectSlug,
        states,
        after: after ?? null,
      });
      if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
      const conn = (res.data as IssueConnection)?.issues;
      for (const node of conn?.nodes ?? []) out.push(normalizeIssue(node));
      if (conn?.pageInfo?.hasNextPage && conn.pageInfo.endCursor) after = conn.pageInfo.endCursor;
      else break;
    }
    return out;
  }

  async fetchCandidateIssues(): Promise<NormalizedIssue[]> {
    return this.paginate(ISSUES_BY_PROJECT_AND_STATES, this.opts.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<NormalizedIssue[]> {
    return this.paginate(ISSUES_BY_PROJECT_AND_STATES, states);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]> {
    if (ids.length === 0) return [];
    const res = await this.client.graphql(ISSUE_STATES_BY_IDS, { ids });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const nodes = (res.data as IssueConnection)?.issues?.nodes ?? [];
    return nodes.map((n) => ({
      id: n.id,
      identifier: n.identifier,
      state: n.state?.name ?? '',
    }));
  }

  async createIssue(input: {
    title: string;
    description?: string;
    stateName?: string;
    priority?: number;
  }): Promise<NormalizedIssue> {
    const team = await this.resolveTeamAndState(input.stateName);
    const issueInput: Record<string, unknown> = { teamId: team.teamId, title: input.title };
    if (input.description !== undefined) issueInput['description'] = input.description;
    if (input.priority !== undefined) issueInput['priority'] = input.priority;
    if (team.stateId) issueInput['stateId'] = team.stateId;

    const res = await this.client.graphql(CREATE_ISSUE, { input: issueInput });
    if (res.errors?.length) throw new Error(`Linear GraphQL error: ${res.errors[0]!.message}`);
    const created = (res.data as { issueCreate?: { success?: boolean; issue?: RawLinearIssue } })
      ?.issueCreate;
    if (!created?.success || !created.issue) throw new Error('Linear issueCreate failed');
    return normalizeIssue(created.issue);
  }

  private async resolveTeamAndState(
    stateName?: string,
  ): Promise<{ teamId: string; stateId?: string }> {
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
    let stateId: string | undefined;
    if (stateName) {
      stateId = team.states?.nodes?.find((s) => s.name === stateName)?.id;
      if (!stateId) throw new Error(`workflow state "${stateName}" not found on team`);
    }
    return stateId ? { teamId: team.id, stateId } : { teamId: team.id };
  }
}
