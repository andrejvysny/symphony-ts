import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, resolveConfig } from './resolve.js';

const ENV_KEYS = ['LINEAR_API_KEY', 'SYMPHONY_TEST_TOKEN'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('config parse + resolve', () => {
  it('applies Symphony custom-state defaults', () => {
    const c = resolveConfig(
      parseConfig({ tracker: { kind: 'linear', project_slug: 'p' } }),
      '/tmp',
    );
    expect(c.tracker.active_states).toContain('Rework');
    expect(c.tracker.active_states).toContain('Merging');
    expect(c.tracker.terminal_states).toContain('Done');
    expect(c.agent.backend).toBe('claude-sdk');
    expect(c.agent.permission_mode).toBe('bypassPermissions');
  });

  it('resolves $VAR for api_key and falls back to LINEAR_API_KEY', () => {
    process.env['SYMPHONY_TEST_TOKEN'] = 'tok-123';
    const c = resolveConfig(
      parseConfig({
        tracker: { kind: 'linear', project_slug: 'p', api_key: '$SYMPHONY_TEST_TOKEN' },
      }),
      '/tmp',
    );
    expect(c.tracker.api_key).toBe('tok-123');

    process.env['LINEAR_API_KEY'] = 'fallback';
    const c2 = resolveConfig(
      parseConfig({ tracker: { kind: 'linear', project_slug: 'p' } }),
      '/tmp',
    );
    expect(c2.tracker.api_key).toBe('fallback');
  });

  it('expands ~ and resolves workspace.root to absolute', () => {
    const c = resolveConfig(
      parseConfig({ tracker: { kind: 'memory' }, workspace: { root: 'ws' } }),
      '/base',
    );
    expect(c.workspace.root).toBe('/base/ws');
  });

  it('keeps remote repo URLs verbatim but absolutizes local paths', () => {
    const remote = resolveConfig(
      parseConfig({ tracker: { kind: 'memory' }, workspace: { repo: 'git@github.com:o/r.git' } }),
      '/base',
    );
    expect(remote.workspace.repo).toBe('git@github.com:o/r.git');
    const local = resolveConfig(
      parseConfig({ tracker: { kind: 'memory' }, workspace: { repo: './r' } }),
      '/base',
    );
    expect(local.workspace.repo).toBe('/base/r');
  });

  it('maps legacy codex timeouts onto agent when agent block absent', () => {
    const c = resolveConfig(
      parseConfig({
        tracker: { kind: 'memory' },
        codex: { stall_timeout_ms: 1234, turn_timeout_ms: 99 },
      }),
      '/tmp',
    );
    expect(c.agent.backend).toBe('codex-cli');
    expect(c.agent.stall_timeout_ms).toBe(1234);
    expect(c.agent.turn_timeout_ms).toBe(99);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => parseConfig({ tracker: { kind: 'memory' }, bogus: 1 })).toThrow();
  });
});
