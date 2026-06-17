import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { makeLinearGraphqlExecutor } from './linear-graphql.js';
import { buildStdioLinearServer } from './stdio-linear-server.js';

describe('stdio linear MCP server', () => {
  it('exposes linear_graphql and routes valid calls to the executor', async () => {
    const calls: Array<{ q: string; v: Record<string, unknown> }> = [];
    const executor = makeLinearGraphqlExecutor(async (q, v) => {
      calls.push({ q, v });
      return { data: { issueUpdate: { success: true } } };
    });
    const server = buildStdioLinearServer(executor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('linear_graphql');

    const res = await client.callTool({
      name: 'linear_graphql',
      arguments: {
        query: 'mutation { issueUpdate(id: "1", input: { stateId: "s" }) { success } }',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      data: { issueUpdate: { success: true } },
    });

    // The shared validator rejects multi-operation documents before hitting the executor.
    const bad = await client.callTool({
      name: 'linear_graphql',
      arguments: { query: 'query A { a } query B { b }' },
    });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);

    await client.close();
  });
});
