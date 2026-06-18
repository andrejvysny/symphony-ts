import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BridgeClient,
  buildStdioTrackerServer,
  connectBridge,
  type TrackerStdioToolDeps,
} from './stdio-tracker-server.js';
import type { ToolResult } from './file-semantic.js';

function fakeClient(over: Partial<BridgeClient> = {}): BridgeClient {
  return {
    call: vi
      .fn<(tool: string, input: unknown) => Promise<ToolResult>>()
      .mockResolvedValue({ success: true, output: JSON.stringify({ data: { ok: true } }) }),
    ...over,
  };
}

function deps(over: Partial<TrackerStdioToolDeps> = {}): TrackerStdioToolDeps {
  return { client: fakeClient(), allowedStates: ['Todo', 'In Progress', 'Human Review'], ...over };
}

function registered(
  server: unknown,
): Record<string, { handler: (a: unknown) => Promise<unknown> }> {
  return (
    server as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> }
  )._registeredTools;
}

describe('buildStdioTrackerServer', () => {
  it('registers exactly the three semantic tracker tools (no tracker_api)', () => {
    const tools = registered(buildStdioTrackerServer(deps()));
    expect(Object.keys(tools).sort()).toEqual([
      'tracker_add_comment',
      'tracker_get_task',
      'tracker_update_status',
    ]);
  });

  it('proxies a call to the bridge client and wraps the output as text content', async () => {
    const client = fakeClient({
      call: vi.fn<(tool: string, input: unknown) => Promise<ToolResult>>().mockResolvedValue({
        success: true,
        output: JSON.stringify({ data: { title: 'Add login' } }),
      }),
    });
    const tools = registered(buildStdioTrackerServer(deps({ client })));
    const res = (await tools['tracker_get_task']?.handler({ task_id: 'abc' })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(client.call).toHaveBeenCalledWith('tracker_get_task', { task_id: 'abc' });
    expect(res.content[0]?.text).toContain('Add login');
    expect(res.isError).toBe(false);
  });

  it('sets isError:true when the bridge returns success:false', async () => {
    const client = fakeClient({
      call: () => Promise.resolve({ success: false, output: JSON.stringify({ error: 'nope' }) }),
    });
    const tools = registered(buildStdioTrackerServer(deps({ client })));
    const res = (await tools['tracker_update_status']?.handler({
      task_id: 'abc',
      status: 'Todo',
    })) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('nope');
  });
});

describe('connectBridge', () => {
  let root: string;
  let server: net.Server;
  let socketPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-cb-'));
    socketPath = path.join(root, 'tracker.sock');
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a request and matches the response by id', async () => {
    server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('data', (line: string) => {
        const req = JSON.parse(line.trim()) as { id: number; tool: string; input: unknown };
        sock.write(
          `${JSON.stringify({ id: req.id, result: { success: true, output: JSON.stringify({ data: req }) } })}\n`,
        );
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const client = connectBridge(socketPath);
    const r = await client.call('tracker_get_task', { task_id: 'SYM-1' });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output).data).toMatchObject({
      tool: 'tracker_get_task',
      input: { task_id: 'SYM-1' },
    });
    client.close();
  });

  it('fails in-flight calls when the connection closes', async () => {
    server = net.createServer((sock) => {
      // accept but never respond, then drop the connection
      sock.on('data', () => sock.destroy());
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const client = connectBridge(socketPath);
    const r = await client.call('tracker_get_task', { task_id: 'X' });
    expect(r.success).toBe(false);
    expect(JSON.parse(r.output).error).toMatch(/connection/);
  });
});
