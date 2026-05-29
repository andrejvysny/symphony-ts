import { describe, expect, it } from 'vitest';
import type { Transport, TransportResponse } from './client.js';
import { LinearTracker, type HttpPut } from './adapter.js';

function ok(data: unknown): TransportResponse {
  return { statusCode: 200, headers: {}, json: async () => ({ data }), dump: async () => {} };
}

/** Route a GraphQL request by operation name embedded in the query. */
function router(handlers: Record<string, (vars: Record<string, unknown>) => unknown>): Transport {
  return async (_url, init) => {
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const name = /\b(Symphony\w+)\b/.exec(query)?.[1] ?? '';
    const handler = handlers[name];
    if (!handler) throw new Error(`no handler for ${name}`);
    return ok(handler(variables));
  };
}

const opts = { endpoint: 'https://x', apiKey: 'k', projectSlug: 'p', activeStates: ['Todo'] };

describe('LinearTracker board + writes', () => {
  it('fetchAllIssues paginates across pages', async () => {
    let page = 0;
    const transport = router({
      SymphonyAllIssues: () => {
        page += 1;
        return page === 1
          ? {
              issues: {
                nodes: [{ id: 'i1', identifier: 'A-1', title: 'one', state: { name: 'Todo' } }],
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
              },
            }
          : {
              issues: {
                nodes: [{ id: 'i2', identifier: 'A-2', title: 'two', state: { name: 'Done' } }],
                pageInfo: { hasNextPage: false },
              },
            };
      },
    });
    const t = new LinearTracker({ ...opts, transport });
    const issues = await t.fetchAllIssues();
    expect(issues.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(page).toBe(2);
  });

  it('listWorkflowStates returns states sorted by position', async () => {
    const transport = router({
      SymphonyStatesList: () => ({
        workflowStates: {
          nodes: [
            { id: 's2', name: 'In Progress', type: 'started', position: 2 },
            { id: 's1', name: 'Todo', type: 'unstarted', position: 1 },
          ],
        },
      }),
    });
    const t = new LinearTracker({ ...opts, transport });
    const states = await t.listWorkflowStates();
    expect(states.map((s) => s.name)).toEqual(['Todo', 'In Progress']);
  });

  it('updateIssueState issues the mutation and checks success', async () => {
    const seen: Record<string, unknown>[] = [];
    const transport = router({
      SymphonyUpdateState: (vars) => {
        seen.push(vars);
        return {
          issueUpdate: { success: true, issue: { id: vars['id'], state: { name: 'Done' } } },
        };
      },
    });
    const t = new LinearTracker({ ...opts, transport });
    await t.updateIssueState('i1', 'state-done');
    expect(seen[0]).toEqual({ id: 'i1', stateId: 'state-done' });
  });

  it('uploadFile runs the fileUpload mutation then PUTs the bytes', async () => {
    const puts: Array<{ url: string; size: number }> = [];
    const httpPut: HttpPut = async (url, _headers, body) => {
      puts.push({ url, size: body.length });
      return { statusCode: 200 };
    };
    const transport = router({
      SymphonyFileUpload: () => ({
        fileUpload: {
          success: true,
          uploadFile: {
            uploadUrl: 'https://upload/abc',
            assetUrl: 'https://assets/abc',
            headers: [{ key: 'x-amz-meta', value: '1' }],
          },
        },
      }),
    });
    const t = new LinearTracker({ ...opts, transport, httpPut });
    const res = await t.uploadFile({
      filename: 'a.txt',
      contentType: 'text/plain',
      data: Buffer.from('hello'),
    });
    expect(res.assetUrl).toBe('https://assets/abc');
    expect(puts).toEqual([{ url: 'https://upload/abc', size: 5 }]);
  });

  it('createIssue embeds attachment markdown in the description', async () => {
    let createdInput: Record<string, unknown> | undefined;
    const transport = router({
      SymphonyProjectTeam: () => ({
        projects: {
          nodes: [{ id: 'pr', teams: { nodes: [{ id: 'team-1', states: { nodes: [] } }] } }],
        },
      }),
      SymphonyCreateIssue: (vars) => {
        createdInput = vars['input'] as Record<string, unknown>;
        return {
          issueCreate: {
            success: true,
            issue: { id: 'new1', identifier: 'A-9', title: 'T', state: { name: 'Todo' } },
          },
        };
      },
    });
    const t = new LinearTracker({ ...opts, transport });
    const issue = await t.createIssue({
      title: 'T',
      description: 'body',
      attachments: [{ url: 'https://assets/abc', title: 'a.txt' }],
    });
    expect(issue.identifier).toBe('A-9');
    expect(String(createdInput?.['description'])).toContain('![a.txt](https://assets/abc)');
    expect(createdInput?.['teamId']).toBe('team-1');
  });
});
