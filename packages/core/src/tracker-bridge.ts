import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { SemanticTools } from '@symphony/tracker';

function errno(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined;
}

/** Resolve `listen()` on success, reject on the FIRST `error` (e.g. EADDRINUSE, path too long). */
function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

/** Probe an existing socket: `true` if a live listener accepts a connection, `false` if stale. */
function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    const settle = (live: boolean): void => {
      client.destroy();
      resolve(live);
    };
    client.once('connect', () => settle(true));
    client.once('error', () => settle(false));
  });
}

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
  // Windows uses the named-pipe namespace (no filesystem entry); Unix uses a socket file we manage.
  const isPipe = process.platform === 'win32';
  if (!isPipe)
    // Ensure data_root exists — on a first run the socket's parent dir (e.g. ~/.symphony) may not
    // exist yet, and net.Server.listen() would fail before any project is created.
    await fs.mkdir(path.dirname(socketPath), { recursive: true });

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

  try {
    await listen(server, socketPath);
  } catch (e) {
    if (errno(e) !== 'EADDRINUSE') {
      throw new Error(`tracker bridge: cannot listen on ${socketPath}: ${(e as Error).message}`);
    }
    // Endpoint in use: refuse to steal a LIVE one (protects the single-writer invariant), but
    // recover a stale socket left by a crashed run. Windows pipes vanish with their process, so an
    // in-use pipe is always a live peer.
    if (!isPipe && !(await isSocketLive(socketPath))) {
      await fs.rm(socketPath, { force: true });
      await listen(server, socketPath); // retry once; propagate if it still fails
    } else {
      throw new Error(
        `tracker bridge: another Symphony instance is already running on ${socketPath} ` +
          `(same data_root). Stop it first, or use a different tracker.data_root.`,
      );
    }
  }

  return {
    socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Remove only our own endpoint (Unix socket file); Windows pipes are cleaned up by the OS.
      if (!isPipe) await fs.rm(socketPath, { force: true });
    },
  };
}
