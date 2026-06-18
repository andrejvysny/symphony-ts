import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { SemanticTools } from '@symphony/tracker';

/**
 * Loopback Unix-socket bridge that lets out-of-process CLI agents drive the tracker through the
 * orchestrator process — making the orchestrator the single writer of the file store (no
 * cross-process file locking). The in-process SDK backend never uses this; it calls the same
 * executors directly. `resolveTools` is invoked per request so the bridge always targets the
 * CURRENT project (it follows `switchProject`).
 *
 * Line protocol (newline-delimited JSON): request `{ id, tool, input }` → response
 * `{ id, result: { success, output } }`, where `output` is the tool's JSON string.
 */
export interface TrackerBridge {
  socketPath: string;
  close(): Promise<void>;
}

export async function startTrackerBridge(opts: {
  socketPath: string;
  resolveTools: () => SemanticTools;
}): Promise<TrackerBridge> {
  const { socketPath, resolveTools } = opts;
  // Clear any stale socket left by a crashed previous run.
  await fs.rm(socketPath, { force: true });

  const dispatch = async (line: string, sock: net.Socket): Promise<void> => {
    let req: { id?: unknown; tool?: unknown; input?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      return;
    }
    let result: { success: boolean; output: string };
    try {
      const tools = resolveTools();
      const exec =
        req.tool === 'tracker_get_task'
          ? tools.getTask
          : req.tool === 'tracker_update_status'
            ? tools.updateStatus
            : req.tool === 'tracker_add_comment'
              ? tools.addComment
              : undefined;
      result = exec
        ? await exec(req.input)
        : {
            success: false,
            output: JSON.stringify({ error: `unknown tool: ${String(req.tool)}` }),
          };
    } catch (e) {
      result = { success: false, output: JSON.stringify({ error: (e as Error).message }) };
    }
    if (!sock.destroyed) sock.write(`${JSON.stringify({ id: req.id, result })}\n`);
  };

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length > 0) void dispatch(line, sock);
      }
    });
    sock.on('error', () => {});
  });

  server.listen(socketPath);
  await once(server, 'listening');

  return {
    socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    },
  };
}
