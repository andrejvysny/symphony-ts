import { describe, expect, it } from 'vitest';
import { classify, isPermanentCategory } from './failure-classification.js';

describe('classify', () => {
  it('flags a missing CLI as permanent agent_not_found', () => {
    expect(classify({ text: 'spawn claude ENOENT' })).toEqual({
      category: 'agent_not_found',
      retryable: false,
    });
    expect(classify({ text: 'claude: command not found' }).category).toBe('agent_not_found');
    expect(classify({ category: 'agent_not_found' }).retryable).toBe(false);
  });

  it('flags auth problems as permanent (operator must log in)', () => {
    for (const t of [
      'Error: Unauthorized',
      'You are not logged in',
      'authentication required',
      'ANTHROPIC_API_KEY is missing',
      'refresh token expired',
    ]) {
      const c = classify({ text: t });
      expect(c).toEqual({ category: 'auth_required', retryable: false });
    }
  });

  it('flags oversized prompts as permanent prompt_too_large', () => {
    expect(classify({ text: 'prompt is too large for the maximum context length' })).toEqual({
      category: 'prompt_too_large',
      retryable: false,
    });
  });

  it('treats a soft rate limit as retryable but a hard quota as permanent', () => {
    expect(classify({ text: 'HTTP 429 Too Many Requests' })).toEqual({
      category: 'rate_limited',
      retryable: true,
    });
    expect(classify({ text: 'You have hit your usage limit' })).toEqual({
      category: 'rate_limited',
      retryable: false,
    });
    expect(classify({ text: 'insufficient credit' }).retryable).toBe(false);
  });

  it('treats upstream/network blips as retryable upstream_unavailable', () => {
    for (const t of [
      '503 Service Unavailable',
      'ECONNRESET',
      'stream disconnected',
      'bad gateway',
    ]) {
      expect(classify({ text: t })).toEqual({ category: 'upstream_unavailable', retryable: true });
    }
  });

  it('distinguishes inactivity (idle) from plain timeouts; both retryable', () => {
    expect(classify({ text: 'request timed out' })).toEqual({
      category: 'turn_timeout',
      retryable: true,
    });
    expect(classify({ text: 'no new output for 300s' })).toEqual({
      category: 'idle_timeout',
      retryable: true,
    });
  });

  it('treats empty output as a retryable response_error', () => {
    expect(classify({ text: 'the model returned an empty response' })).toEqual({
      category: 'response_error',
      retryable: true,
    });
  });

  it('treats process crashes / OOM kills as permanent, never laundered into a timeout', () => {
    expect(classify({ signal: 'SIGSEGV' })).toEqual({ category: 'process_exit', retryable: false });
    expect(classify({ signal: 'SIGKILL' })).toEqual({ category: 'process_exit', retryable: false });
    // A timeout-shaped text still loses to a crash signal (signal checked first).
    expect(classify({ signal: 'SIGABRT', text: 'timed out' }).retryable).toBe(false);
  });

  it('lets a graceful SIGTERM fall through (not a crash)', () => {
    const c = classify({ signal: 'SIGTERM' });
    expect(c.retryable).toBe(true);
    expect(c.category).toBe('response_error');
  });

  it('falls back to a retryable process_exit on a bare non-zero exit code', () => {
    expect(classify({ exitCode: 1 })).toEqual({ category: 'process_exit', retryable: true });
    expect(classify({ exitCode: 0 })).toEqual({ category: 'response_error', retryable: true });
  });

  it('derives retryability from a passed-through category it did not refine', () => {
    expect(classify({ category: 'invalid_workspace_cwd' }).retryable).toBe(false);
    expect(classify({ category: 'turn_timeout' }).retryable).toBe(true);
  });
});

describe('isPermanentCategory', () => {
  it('marks the operator-attention categories permanent', () => {
    for (const c of [
      'agent_not_found',
      'invalid_workspace_cwd',
      'auth_required',
      'prompt_too_large',
    ] as const) {
      expect(isPermanentCategory(c)).toBe(true);
    }
    for (const c of [
      'turn_timeout',
      'rate_limited',
      'upstream_unavailable',
      'idle_timeout',
    ] as const) {
      expect(isPermanentCategory(c)).toBe(false);
    }
  });
});
