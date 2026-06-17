import { describe, expect, it } from 'vitest';
import type { RunOptions } from '../backend.js';
import { claudeCliDef } from './agent-defs.js';

const base: RunOptions = { prompt: 'x', cwd: '/tmp' };

describe('claudeCliDef.buildArgs', () => {
  it('is hermetic by default: includes --strict-mcp-config, omits when disabled (H1)', () => {
    expect(claudeCliDef.buildArgs(base, true)).toContain('--strict-mcp-config');
    expect(claudeCliDef.buildArgs({ ...base, strictMcpConfig: false }, true)).not.toContain(
      '--strict-mcp-config',
    );
  });

  it('gates --include-partial-messages on opt-in AND probed capability (O4)', () => {
    const on = { partialMessages: true, addDir: false };
    const off = { partialMessages: false, addDir: false };
    expect(claudeCliDef.buildArgs({ ...base, streamPartialMessages: true }, true, on)).toContain(
      '--include-partial-messages',
    );
    // Opted in but the build lacks the flag → omitted.
    expect(
      claudeCliDef.buildArgs({ ...base, streamPartialMessages: true }, true, off),
    ).not.toContain('--include-partial-messages');
    // Capable but not opted in → omitted (default off).
    expect(
      claudeCliDef.buildArgs({ ...base, streamPartialMessages: false }, true, on),
    ).not.toContain('--include-partial-messages');
  });
});
