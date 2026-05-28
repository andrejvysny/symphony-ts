import { execa } from 'execa';
import type { HooksConfig } from '../config/schema.js';

export type HookName = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface HookContext {
  cwd: string;
  env?: Record<string, string>;
}

export interface HookOutcome {
  ran: boolean;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Run a workflow hook as `bash -lc <script>` in the workspace dir (SPEC §9.4).
 * Returns an outcome; the caller decides whether failure is fatal (after_create,
 * before_run are fatal; after_run, before_remove are best-effort).
 */
export async function runHook(
  hooks: HooksConfig,
  name: HookName,
  ctx: HookContext,
): Promise<HookOutcome> {
  const script = hooks[name];
  if (!script || script.trim().length === 0) return { ran: false, ok: true };

  try {
    const result = await execa('bash', ['-lc', script], {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env },
      timeout: hooks.timeout_ms,
      reject: false,
      all: false,
    });
    const ok = result.exitCode === 0 && !result.timedOut;
    return {
      ran: true,
      ok,
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      ...(ok
        ? {}
        : { error: result.timedOut ? 'hook timed out' : `hook exited ${result.exitCode}` }),
    };
  } catch (e) {
    return { ran: true, ok: false, error: (e as Error).message };
  }
}
