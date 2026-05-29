import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { nowIso, type AgentEvent, type RunOptions, type RunResult } from '../backend.js';
import type { AgentDef } from './agent-defs.js';
import { resultFromEvents, type ParseCtx } from './parsers/common.js';
import { defaultTmuxController, type TmuxController } from './tmux.js';

function stdinPayload(def: AgentDef, opts: RunOptions): string {
  if (def.kind === 'claude-cli') {
    // stream-json input: one JSONL user message.
    return (
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: opts.prompt }] },
      }) + '\n'
    );
  }
  return opts.prompt;
}

/** Parse one raw stdout line into normalized events, recording them in `collected`. */
function* emitForLine(
  def: AgentDef,
  ctx: ParseCtx,
  rawLine: string,
  collected: AgentEvent[],
): Generator<AgentEvent> {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return; // non-JSON diagnostic line
  }
  for (const ev of def.parser(json, ctx)) {
    collected.push(ev);
    yield ev;
  }
}

/**
 * Spawn a CLI agent, stream its JSONL stdout through the def's parser into the
 * normalized AgentEvent vocabulary, and synthesize a RunResult on close. When
 * `opts.tmux` is set, the agent instead runs under a tmux session (attachable +
 * raw log file) — see {@link runViaTmux}.
 */
export async function* runAgentDef(
  def: AgentDef,
  opts: RunOptions,
  tmux: TmuxController = defaultTmuxController,
): AsyncGenerator<AgentEvent, RunResult, void> {
  if (opts.tmux) return yield* runViaTmux(def, opts, tmux);

  const args = def.buildArgs(opts, def.promptViaStdin);
  const child = spawn(def.binary, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(def.env?.(opts) ?? {}) },
    stdio: [def.promptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  if (opts.signal) {
    if (opts.signal.aborted) child.kill('SIGTERM');
    else opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  }

  let timedOut = false;
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;

  const stderrChunks: string[] = [];
  child.stderr?.on('data', (d: Buffer) => {
    if (stderrChunks.length < 50) stderrChunks.push(d.toString());
  });

  if (def.promptViaStdin && child.stdin) {
    child.stdin.write(stdinPayload(def, opts));
    child.stdin.end();
  }

  const ctx: ParseCtx = {};
  const collected: AgentEvent[] = [];

  const exitPromise = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(127));
  });

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  for await (const line of rl) {
    yield* emitForLine(def, ctx, line, collected);
  }

  const exitCode = await exitPromise;
  if (timer) clearTimeout(timer);

  let result = resultFromEvents(collected, exitCode, ctx.sessionId);
  if (timedOut) {
    result = {
      ...result,
      status: 'error_execution',
      error: 'turn timed out',
      errorCategory: 'turn_timeout',
    };
  }
  yield { type: 'result', result, at: nowIso() };
  return result;
}

/** POSIX single-quote a string for embedding in a `bash -lc` command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 250;

/**
 * Run a CLI agent inside a detached tmux session. The agent's stdout is `tee`d to
 * a raw `run.jsonl` log (clean bytes, unaffected by pty width) which the parent
 * tails to parse events; `tmux attach -t <sessionName>` shows it live. Abort or
 * timeout kills the session.
 */
async function* runViaTmux(
  def: AgentDef,
  opts: RunOptions,
  tmux: TmuxController,
): AsyncGenerator<AgentEvent, RunResult, void> {
  const { sessionName, logDir } = opts.tmux!;
  await mkdir(logDir, { recursive: true });
  const runLog = path.join(logDir, 'run.jsonl');
  const errLog = path.join(logDir, 'err.log');
  const exitFile = path.join(logDir, 'exit.code');
  await writeFile(runLog, '');
  await rm(exitFile, { force: true });

  const args = def.buildArgs(opts, def.promptViaStdin);
  let inner = [def.binary, ...args].map(shQuote).join(' ');
  if (def.promptViaStdin) {
    const promptFile = path.join(logDir, 'prompt.txt');
    await writeFile(promptFile, stdinPayload(def, opts));
    inner += ` < ${shQuote(promptFile)}`;
  }
  const wrapped = `set -o pipefail; { ${inner} ; } 2> ${shQuote(errLog)} | tee ${shQuote(runLog)}; echo $? > ${shQuote(exitFile)}`;
  await tmux.newSession(sessionName, opts.cwd, `bash -lc ${shQuote(wrapped)}`);

  const pid = await tmux.panePid(sessionName);
  yield {
    type: 'process_started',
    tmuxSession: sessionName,
    ...(pid !== null ? { pid } : {}),
    at: nowIso(),
  };

  let timedOut = false;
  const onAbort = (): void => void tmux.killSession(sessionName);
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          void tmux.killSession(sessionName);
        }, opts.timeoutMs)
      : undefined;

  const ctx: ParseCtx = {};
  const collected: AgentEvent[] = [];
  let offset = 0;
  let buffer = '';

  const drain = async function* (): AsyncGenerator<AgentEvent> {
    const fh = await open(runLog, 'r');
    try {
      const { size } = await fh.stat();
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        await fh.read(buf, 0, buf.length, offset);
        offset = size;
        buffer += buf.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          yield* emitForLine(def, ctx, line, collected);
        }
      }
    } finally {
      await fh.close();
    }
  };

  for (;;) {
    yield* drain();
    if (!(await tmux.hasSession(sessionName))) break;
    await delay(POLL_MS);
  }
  yield* drain();
  if (buffer.trim()) yield* emitForLine(def, ctx, buffer, collected);

  if (timer) clearTimeout(timer);
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  await tmux.killSession(sessionName);

  let exitCode = 0;
  try {
    const parsed = Number.parseInt((await readFile(exitFile, 'utf8')).trim(), 10);
    exitCode = Number.isFinite(parsed) ? parsed : 0;
  } catch {
    exitCode = timedOut ? 137 : 0;
  }

  let result = resultFromEvents(collected, exitCode, ctx.sessionId);
  if (timedOut) {
    result = {
      ...result,
      status: 'error_execution',
      error: 'turn timed out',
      errorCategory: 'turn_timeout',
    };
  }
  yield { type: 'result', result, at: nowIso() };
  return result;
}
