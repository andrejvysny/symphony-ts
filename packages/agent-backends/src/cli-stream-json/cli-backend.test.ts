import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../backend.js';
import { cliBackendFor } from './cli-backend.js';

async function drain(gen: AsyncGenerator<unknown, RunResult, void>): Promise<RunResult> {
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

describe('cliBackendFor command override (W1)', () => {
  it('spawns the overridden binary instead of the def default', async () => {
    // A stub that ignores all args, drains stdin, and emits one stream-json result line
    // carrying a unique session id. The real `claude` binary would never produce this id,
    // so seeing it proves the `command` override reached `def.binary`.
    const dir = await mkdtemp(path.join(tmpdir(), 'symphony-cmd-'));
    const stub = path.join(dir, 'fake-claude.sh');
    await writeFile(
      stub,
      `#!/bin/sh\ncat >/dev/null 2>&1 || true\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"override-ok"}'\nprintf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}'\n`,
    );
    await chmod(stub, 0o755);

    const backend = cliBackendFor('claude-cli', stub);
    const opts: RunOptions = { prompt: 'x', cwd: process.cwd() };
    const result = await drain(backend.run(opts));

    expect(result.status).toBe('success');
    expect(result.sessionId).toBe('override-ok');
  });

  it('falls back to the def default binary when no command is given', () => {
    const backend = cliBackendFor('claude-cli');
    expect(backend.kind).toBe('claude-cli');
  });
});
