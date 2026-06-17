import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { nowIso, type AgentEvent, type RunOptions, type RunResult } from '../backend.js';
import type { AgentDef } from './agent-defs.js';
import { detectedCapabilities } from './detect.js';
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

/** Cap on retained non-JSON stdout lines (diagnostics) so a runaway non-JSON stream can't grow unbounded. */
const RAW_DROPPED_CAP = 50;

/**
 * Parse one raw stdout line into normalized events, recording them in `collected`. A line that is not
 * valid JSON is NOT silently discarded: it is captured into `rawDropped` (bounded) so the engine can
 * fold it into the failure text/classification instead of losing a diagnostic or a truncated result.
 */
function* emitForLine(
  def: AgentDef,
  ctx: ParseCtx,
  rawLine: string,
  collected: AgentEvent[],
  rawDropped: string[],
): Generator<AgentEvent> {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    if (rawDropped.length < RAW_DROPPED_CAP) rawDropped.push(trimmed);
    return;
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

  const args = def.buildArgs(opts, def.promptViaStdin, detectedCapabilities(def.binary));
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

  // Soft idle watchdog: reset on every stdout line; SIGTERM (then SIGKILL after a grace) when the
  // stream goes silent for `idleTimeoutMs`. Catches hung tools / upstream stalls long before the
  // hard `timeoutMs`. 0 disables.
  let idledOut = false;
  const idleMs = opts.idleTimeoutMs ?? 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleKillTimer: NodeJS.Timeout | undefined;
  const resetIdle = (): void => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idledOut = true;
      child.kill('SIGTERM');
      idleKillTimer = setTimeout(() => child.kill('SIGKILL'), IDLE_GRACE_MS);
    }, idleMs);
  };
  resetIdle();

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
  const rawDropped: string[] = [];

  const exitPromise = new Promise<{ code: number; exitSignal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, exitSignal) =>
        resolve({ code: code ?? 0, exitSignal: exitSignal ?? null }),
      );
      child.on('error', () => resolve({ code: 127, exitSignal: null }));
    },
  );

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  for await (const line of rl) {
    resetIdle();
    yield* emitForLine(def, ctx, line, collected, rawDropped);
  }

  const { code: exitCode, exitSignal } = await exitPromise;
  if (timer) clearTimeout(timer);
  if (idleTimer) clearTimeout(idleTimer);
  if (idleKillTimer) clearTimeout(idleKillTimer);

  let result = resultFromEvents(collected, exitCode, ctx.sessionId, {
    signal: exitSignal,
    stderr: joinDiagnostics(stderrChunks.join(''), rawDropped),
  });
  if (timedOut) {
    result = {
      ...result,
      status: 'error_execution',
      error: 'turn timed out',
      errorCategory: 'turn_timeout',
      retryable: true,
    };
  } else if (idledOut) {
    result = {
      ...result,
      status: 'error_execution',
      error: `no agent activity for ${idleMs}ms (idle watchdog)`,
      errorCategory: 'idle_timeout',
      retryable: true,
    };
  } else {
    result = applyBudget(result, opts.maxBudgetUsd);
  }
  yield { type: 'result', result, at: nowIso() };
  return result;
}

/**
 * CLI budget parity with the SDK's `maxBudgetUsd`: if the turn's reported cost exceeds the cap, mark
 * it `error_budget` (non-retryable — operator must raise the cap). claude stream-json reports cost
 * only in the final `result` line, so enforcement is end-of-turn for the non-tmux path.
 */
function applyBudget(result: RunResult, maxBudgetUsd: number | undefined): RunResult {
  if (maxBudgetUsd === undefined || (result.costUsd ?? 0) <= maxBudgetUsd) return result;
  return {
    ...result,
    status: 'error_budget',
    error: `cost budget exceeded ($${result.costUsd} > $${maxBudgetUsd})`,
    retryable: false,
  };
}

/** Fold captured non-JSON stdout lines into the stderr diagnostics so they aren't silently lost. */
function joinDiagnostics(stderr: string, rawDropped: string[]): string {
  if (rawDropped.length === 0) return stderr;
  const note = `[${rawDropped.length} non-JSON stdout line(s)]\n${rawDropped.join('\n')}`;
  return stderr ? `${stderr}\n${note}` : note;
}

/** POSIX single-quote a string for embedding in a `bash -lc` command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 250;
/** Grace between the idle watchdog's SIGTERM and the follow-up SIGKILL. */
const IDLE_GRACE_MS = 5_000;

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

  const args = def.buildArgs(opts, def.promptViaStdin, detectedCapabilities(def.binary));
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
  const rawDropped: string[] = [];
  let offset = 0;
  let buffer = '';

  // Idle watchdog (wall-clock; the tmux session runs in real time): kill the session if no new
  // event is drained for `idleTimeoutMs`. 0 disables.
  let idledOut = false;
  let budgetKilled = false;
  const idleMs = opts.idleTimeoutMs ?? 0;
  let lastActivity = Date.now();
  const latestCostUsd = (): number => {
    for (let i = collected.length - 1; i >= 0; i--) {
      const e = collected[i];
      if (e?.type === 'usage' && e.costUsd !== undefined) return e.costUsd;
    }
    return 0;
  };

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
          yield* emitForLine(def, ctx, line, collected, rawDropped);
        }
      }
    } finally {
      await fh.close();
    }
  };

  for (;;) {
    const before = collected.length;
    yield* drain();
    if (collected.length > before) lastActivity = Date.now();
    if (opts.maxBudgetUsd !== undefined && latestCostUsd() > opts.maxBudgetUsd) {
      budgetKilled = true;
      await tmux.killSession(sessionName);
      break;
    }
    if (!(await tmux.hasSession(sessionName))) break;
    if (idleMs > 0 && Date.now() - lastActivity > idleMs) {
      idledOut = true;
      await tmux.killSession(sessionName);
      break;
    }
    await delay(POLL_MS);
  }
  yield* drain();
  if (buffer.trim()) yield* emitForLine(def, ctx, buffer, collected, rawDropped);

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

  let errLogText = '';
  try {
    errLogText = (await readFile(errLog, 'utf8')).slice(-2000);
  } catch {
    /* err.log may be absent if the session never started */
  }

  let result = resultFromEvents(collected, exitCode, ctx.sessionId, {
    stderr: joinDiagnostics(errLogText, rawDropped),
  });
  if (timedOut) {
    result = {
      ...result,
      status: 'error_execution',
      error: 'turn timed out',
      errorCategory: 'turn_timeout',
      retryable: true,
    };
  } else if (idledOut) {
    result = {
      ...result,
      status: 'error_execution',
      error: `no agent activity for ${idleMs}ms (idle watchdog)`,
      errorCategory: 'idle_timeout',
      retryable: true,
    };
  } else if (budgetKilled) {
    result = {
      ...result,
      status: 'error_budget',
      error: `cost budget exceeded ($${result.costUsd} > $${opts.maxBudgetUsd})`,
      retryable: false,
    };
  } else {
    result = applyBudget(result, opts.maxBudgetUsd);
  }
  yield { type: 'result', result, at: nowIso() };
  return result;
}
