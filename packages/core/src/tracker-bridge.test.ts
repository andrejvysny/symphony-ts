import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { SemanticTools } from '@symphony/tracker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTrackerBridge, type TrackerBridge } from './tracker-bridge.js';

/** Send one request line over the socket and resolve with the parsed response. */
async function call(
  socketPath: string,
  req: unknown,
): Promise<{ id: unknown; result: { success: boolean; output: string } }> {
  const sock = net.createConnection(socketPath);
  await once(sock, 'connect');
  sock.write(`${JSON.stringify(req)}\n`);
  const [chunk] = (await once(sock, 'data')) as [Buffer];
  sock.end();
  return JSON.parse(chunk.toString('utf8').trim());
}

describe('startTrackerBridge', () => {
  let root: string;
  let bridge: TrackerBridge;
  const calls: Array<[string, unknown]> = [];

  const tools: SemanticTools = {
    getTask: (input) => {
      calls.push(['getTask', input]);
      return Promise.resolve({ success: true, output: JSON.stringify({ data: { id: 'SYM-1' } }) });
    },
    updateStatus: () => Promise.resolve({ success: true, output: '{}' }),
    addComment: () =>
      Promise.resolve({ success: false, output: JSON.stringify({ error: 'nope' }) }),
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-br-'));
    bridge = await startTrackerBridge({
      socketPath: path.join(root, 'tracker.sock'),
      resolveTools: () => tools,
    });
  });
  afterEach(async () => {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  });

  it('routes a tool call to the resolved executor and echoes the id', async () => {
    const res = await call(bridge.socketPath, {
      id: 7,
      tool: 'tracker_get_task',
      input: { task_id: 'SYM-1' },
    });
    expect(res.id).toBe(7);
    expect(res.result.success).toBe(true);
    expect(calls).toContainEqual(['getTask', { task_id: 'SYM-1' }]);
  });

  it('reports an unknown tool as a failed result', async () => {
    const res = await call(bridge.socketPath, { id: 1, tool: 'nope', input: {} });
    expect(res.result.success).toBe(false);
    expect(JSON.parse(res.result.output).error).toMatch(/unknown tool/);
  });

  it('propagates a tool failure result', async () => {
    const res = await call(bridge.socketPath, { id: 2, tool: 'tracker_add_comment', input: {} });
    expect(res.result.success).toBe(false);
  });
});
