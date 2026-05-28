import { describe, expect, it } from 'vitest';
import { err, ok } from './result.js';

describe('Result', () => {
  it('wraps success', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it('wraps failure', () => {
    const e = new Error('boom');
    const r = err(e);
    expect(r).toEqual({ ok: false, error: e });
  });
});
