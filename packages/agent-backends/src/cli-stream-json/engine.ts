import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { nowIso, type AgentEvent, type RunOptions, type RunResult } from '../backend.js';
import type { AgentDef } from './agent-defs.js';
import { resultFromEvents, type ParseCtx } from './parsers/common.js';

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

/**
 * Spawn a CLI agent, stream its JSONL stdout through the def's parser into the
 * normalized AgentEvent vocabulary, and synthesize a RunResult on close.
 */
export async function* runAgentDef(
  def: AgentDef,
  opts: RunOptions,
): AsyncGenerator<AgentEvent, RunResult, void> {
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
    const trimmed = line.trim();
    if (!trimmed) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue; // non-JSON diagnostic line
    }
    for (const ev of def.parser(json, ctx)) {
      collected.push(ev);
      yield ev;
    }
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
