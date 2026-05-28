import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertUnderRoot, sanitizeIdentifier } from './path-safety.js';

describe('sanitizeIdentifier', () => {
  it('keeps safe chars and replaces others', () => {
    expect(sanitizeIdentifier('MT-620')).toBe('MT-620');
    expect(sanitizeIdentifier('a/b c')).toBe('a_b_c');
  });
  it('rejects identifiers that sanitize to . or ..', () => {
    expect(() => sanitizeIdentifier('..')).toThrow();
    expect(() => sanitizeIdentifier('.')).toThrow();
    expect(() => sanitizeIdentifier('')).toThrow();
  });
});

describe('assertUnderRoot', () => {
  const root = os.tmpdir();
  it('accepts a path under root', () => {
    const p = path.join(root, 'MT-1');
    expect(assertUnderRoot(p, root)).toContain('MT-1');
  });
  it('rejects a path that escapes root', () => {
    expect(() => assertUnderRoot(path.join(root, '..', 'evil'), root)).toThrow();
  });
  it('rejects the root itself', () => {
    expect(() => assertUnderRoot(root, root)).toThrow();
  });
});
