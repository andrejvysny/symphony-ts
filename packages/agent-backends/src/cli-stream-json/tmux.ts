import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The tmux operations the engine needs to supervise a CLI agent. Abstracted so
 * unit tests can substitute a fake (no real tmux); {@link defaultTmuxController}
 * shells out to the `tmux` binary.
 */
export interface TmuxController {
  /** Create a detached session running `command` (a shell string) with cwd. */
  newSession(name: string, cwd: string, command: string): Promise<void>;
  /** PID of the session's pane process, or null if unavailable. */
  panePid(name: string): Promise<number | null>;
  /** Whether the session still exists. */
  hasSession(name: string): Promise<boolean>;
  /** Kill the session (idempotent — a missing session is not an error). */
  killSession(name: string): Promise<void>;
}

export const defaultTmuxController: TmuxController = {
  async newSession(name, cwd, command) {
    // -d detached, wide geometry so the agent's stream-json output isn't pty-wrapped.
    await run('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', command], { cwd });
  },

  async panePid(name) {
    try {
      const { stdout } = await run('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}']);
      const pid = Number.parseInt(stdout.trim().split('\n')[0] ?? '', 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  },

  async hasSession(name) {
    try {
      await run('tmux', ['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  },

  async killSession(name) {
    await run('tmux', ['kill-session', '-t', name]).catch(() => undefined);
  },
};

/** Whether a `tmux` binary is available (used to gate the integration test). */
export async function tmuxAvailable(): Promise<boolean> {
  try {
    await run('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}
