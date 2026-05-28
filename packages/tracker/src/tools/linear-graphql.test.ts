import { describe, expect, it, vi } from 'vitest';
import { makeLinearGraphqlExecutor, validateArgs } from './linear-graphql.js';

describe('validateArgs', () => {
  it('accepts a single-operation query with variables', () => {
    const r = validateArgs({ query: 'query Q { viewer { id } }', variables: { x: 1 } });
    expect(r.ok).toBe(true);
  });
  it('rejects empty query', () => {
    expect(validateArgs({ query: '   ' }).ok).toBe(false);
  });
  it('rejects multi-operation documents', () => {
    const r = validateArgs({ query: 'query A { a } query B { b }' });
    expect(r.ok).toBe(false);
  });
  it('rejects non-object variables', () => {
    expect(validateArgs({ query: 'query { a }', variables: [1, 2] }).ok).toBe(false);
  });
  it('rejects invalid GraphQL syntax', () => {
    expect(validateArgs({ query: 'this is not graphql {{{' }).ok).toBe(false);
  });
});

describe('makeLinearGraphqlExecutor', () => {
  it('returns success on a clean transport with no GraphQL errors', async () => {
    const fn = vi.fn().mockResolvedValue({ data: { viewer: { id: 'u1' } } });
    const exec = makeLinearGraphqlExecutor(fn);
    const r = await exec({ query: 'query { viewer { id } }' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('u1');
    expect(fn).toHaveBeenCalledOnce();
  });
  it('returns failure when GraphQL errors are present', async () => {
    const fn = vi.fn().mockResolvedValue({ errors: [{ message: 'nope' }] });
    const exec = makeLinearGraphqlExecutor(fn);
    const r = await exec({ query: 'query { viewer { id } }' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('nope');
  });
  it('returns failure on invalid input without calling the transport', async () => {
    const fn = vi.fn();
    const exec = makeLinearGraphqlExecutor(fn);
    const r = await exec({ query: '' });
    expect(r.success).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
