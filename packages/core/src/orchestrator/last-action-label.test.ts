import type { AgentEvent } from '@symphony/agent-backends';
import { describe, expect, it } from 'vitest';
import { lastActionLabel } from './orchestrator.js';

const AT = '2026-06-17T00:00:00.000Z';
const tool = (toolName: string, input: unknown): AgentEvent => ({
  type: 'tool_use',
  toolName,
  toolUseId: 't',
  input,
  at: AT,
});
const text = (t: string): AgentEvent => ({ type: 'text_delta', text: t, at: AT });

describe('lastActionLabel', () => {
  it('labels a tool_use with the first recognized path-like arg', () => {
    expect(lastActionLabel([tool('Edit', { file_path: '/a/b.ts' })])).toBe('Edit: /a/b.ts');
    expect(lastActionLabel([tool('Bash', { command: 'pnpm test' })])).toBe('Bash: pnpm test');
  });

  it('falls back to the bare tool name when no usable arg is present', () => {
    expect(lastActionLabel([tool('Read', {})])).toBe('Read');
    expect(lastActionLabel([tool('Read', 'not-an-object')])).toBe('Read');
    expect(lastActionLabel([tool('Read', null)])).toBe('Read');
  });

  it('skips blank args by key priority and trims', () => {
    // command is whitespace → skipped; pattern is the next non-empty key.
    expect(lastActionLabel([tool('Grep', { command: '   ', pattern: '  foo  ' })])).toBe(
      'Grep: foo',
    );
  });

  it('collapses whitespace for a text_delta fallback', () => {
    expect(lastActionLabel([text('  hello   world \n done ')])).toBe('hello world done');
  });

  it('truncates labels longer than 64 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const r = lastActionLabel([tool('Edit', { file_path: long })]);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(64);
    expect(r!.endsWith('…')).toBe(true);
    expect(lastActionLabel([text(long)])).toBe(`${'x'.repeat(63)}…`);
  });

  it('scans in reverse and ignores non-action events', () => {
    const buf: AgentEvent[] = [
      tool('Read', { file_path: '/old.ts' }),
      text('latest'),
      { type: 'tool_result', toolUseId: 't', isError: false, content: 'ok', at: AT },
      { type: 'usage', absolute: true, at: AT },
    ];
    expect(lastActionLabel(buf)).toBe('latest');
  });

  it('returns null for an empty buffer or only blank text', () => {
    expect(lastActionLabel([])).toBeNull();
    expect(lastActionLabel([text('   '), { type: 'turn_completed', at: AT }])).toBeNull();
  });
});
