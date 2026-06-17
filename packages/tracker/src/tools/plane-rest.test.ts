import { describe, expect, it, vi } from 'vitest';
import { makePlaneRestExecutor, validateArgs } from './plane-rest.js';

describe('validateArgs: accepted inputs', () => {
  it('accepts GET /states/', () => {
    const result = validateArgs({ method: 'GET', path: '/states/' });
    expect(result.ok).toBe(true);
  });

  it('accepts PATCH /work-items/abc/ with body', () => {
    const result = validateArgs({
      method: 'PATCH',
      path: '/work-items/abc/',
      body: { state: 'x' },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts POST /work-items/abc/comments/ with body', () => {
    const result = validateArgs({
      method: 'POST',
      path: '/work-items/abc/comments/',
      body: { comment_html: '<p>x</p>' },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts GET /work-items/ with query string', () => {
    const result = validateArgs({ method: 'GET', path: '/work-items/?per_page=100' });
    expect(result.ok).toBe(true);
  });

  it('accepts GET /issues/ (legacy alias)', () => {
    const result = validateArgs({ method: 'GET', path: '/issues/' });
    expect(result.ok).toBe(true);
  });

  it('accepts GET /labels/', () => {
    const result = validateArgs({ method: 'GET', path: '/labels/' });
    expect(result.ok).toBe(true);
  });

  it('accepts GET /cycles/', () => {
    const result = validateArgs({ method: 'GET', path: '/cycles/' });
    expect(result.ok).toBe(true);
  });

  it('accepts GET /modules/', () => {
    const result = validateArgs({ method: 'GET', path: '/modules/' });
    expect(result.ok).toBe(true);
  });

  it('accepts GET /members/', () => {
    const result = validateArgs({ method: 'GET', path: '/members/' });
    expect(result.ok).toBe(true);
  });
});

describe('validateArgs: rejected inputs', () => {
  it('rejects DELETE method', () => {
    const result = validateArgs({ method: 'DELETE', path: '/work-items/' });
    expect(result.ok).toBe(false);
  });

  it('rejects PUT method', () => {
    const result = validateArgs({ method: 'PUT', path: '/work-items/' });
    expect(result.ok).toBe(false);
  });

  it('rejects missing path', () => {
    const result = validateArgs({ method: 'GET' });
    expect(result.ok).toBe(false);
  });

  it('rejects empty path', () => {
    const result = validateArgs({ method: 'GET', path: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects whitespace-only path', () => {
    const result = validateArgs({ method: 'GET', path: '   ' });
    expect(result.ok).toBe(false);
  });

  it('rejects absolute URL', () => {
    const result = validateArgs({ method: 'GET', path: 'http://evil/x' });
    expect(result.ok).toBe(false);
  });

  it('rejects protocol-relative URL starting with //', () => {
    const result = validateArgs({ method: 'GET', path: '//evil' });
    expect(result.ok).toBe(false);
  });

  it('rejects backslash path', () => {
    const result = validateArgs({ method: 'GET', path: '\\work-items\\' });
    expect(result.ok).toBe(false);
  });

  it('rejects .. traversal', () => {
    const result = validateArgs({ method: 'GET', path: '/work-items/../../x' });
    expect(result.ok).toBe(false);
  });

  it('rejects encoded %2e%2e traversal', () => {
    const result = validateArgs({ method: 'GET', path: '/work-items/%2e%2e/x' });
    expect(result.ok).toBe(false);
  });

  it('rejects encoded %2f separator', () => {
    const result = validateArgs({ method: 'GET', path: '/work-items%2fmalicious' });
    expect(result.ok).toBe(false);
  });

  it('rejects path containing "workspaces" segment (re-rooting attempt)', () => {
    const result = validateArgs({ method: 'GET', path: '/work-items/../workspaces/other/' });
    expect(result.ok).toBe(false);
  });

  it('rejects path containing "projects" segment (re-rooting attempt)', () => {
    const result = validateArgs({ method: 'GET', path: '/work-items/../projects/' });
    expect(result.ok).toBe(false);
  });

  it('rejects path containing "api" segment', () => {
    const result = validateArgs({ method: 'GET', path: '/api/v1/something' });
    expect(result.ok).toBe(false);
  });

  it('rejects non-allowlisted prefix /admin', () => {
    const result = validateArgs({ method: 'GET', path: '/admin/' });
    expect(result.ok).toBe(false);
  });

  it('rejects /work-itemsX (not a valid prefix match)', () => {
    const result = validateArgs({ method: 'GET', path: '/work-itemsX' });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object body (array)', () => {
    const result = validateArgs({ method: 'POST', path: '/work-items/', body: [1, 2, 3] });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object body (string)', () => {
    const result = validateArgs({ method: 'POST', path: '/work-items/', body: 'text' });
    expect(result.ok).toBe(false);
  });

  it('rejects null input', () => {
    const result = validateArgs(null);
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input (string)', () => {
    const result = validateArgs('not an object');
    expect(result.ok).toBe(false);
  });
});

describe('makePlaneRestExecutor', () => {
  it('valid input calls restFn and returns success:true with data field', async () => {
    const restFn = vi.fn().mockResolvedValue({ id: '1', name: 'Test' });
    const executor = makePlaneRestExecutor(restFn);

    const result = await executor({ method: 'GET', path: '/states/' });

    expect(result.success).toBe(true);
    expect(restFn).toHaveBeenCalledWith('GET', '/states/', undefined);
    const parsed = JSON.parse(result.output) as { data: unknown };
    expect(parsed.data).toEqual({ id: '1', name: 'Test' });
  });

  it('valid input with body passes body to restFn', async () => {
    const restFn = vi.fn().mockResolvedValue({ ok: true });
    const executor = makePlaneRestExecutor(restFn);

    await executor({ method: 'PATCH', path: '/work-items/x/', body: { state: 'sid' } });

    expect(restFn).toHaveBeenCalledWith('PATCH', '/work-items/x/', { state: 'sid' });
  });

  it('restFn throws → returns success:false with error message in output', async () => {
    const restFn = vi.fn().mockRejectedValue(new Error('Plane HTTP 500'));
    const executor = makePlaneRestExecutor(restFn);

    const result = await executor({ method: 'GET', path: '/work-items/' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('Plane HTTP 500');
  });

  it('invalid input returns success:false without calling restFn', async () => {
    const restFn = vi.fn();
    const executor = makePlaneRestExecutor(restFn);

    const result = await executor({ method: 'DELETE', path: '/work-items/' });

    expect(result.success).toBe(false);
    expect(restFn).not.toHaveBeenCalled();
  });

  it('null restFn → success:false without calling restFn', async () => {
    const restFn = vi.fn();
    const executor = makePlaneRestExecutor(restFn);

    const result = await executor(null);

    expect(result.success).toBe(false);
    expect(restFn).not.toHaveBeenCalled();
  });

  it('wraps null restFn result as data:null', async () => {
    const restFn = vi.fn().mockResolvedValue(null);
    const executor = makePlaneRestExecutor(restFn);

    const result = await executor({ method: 'GET', path: '/states/' });

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as { data: unknown };
    expect(parsed.data).toBeNull();
  });
});
