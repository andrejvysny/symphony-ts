import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, resolveConfig } from './resolve.js';

const ENV_KEYS = ['PLANE_API_KEY', 'SYMPHONY_TEST_TOKEN'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const planeTracker = (extra: Record<string, unknown> = {}) => ({
  kind: 'plane',
  endpoint: 'http://localhost',
  workspace_slug: 'ws',
  project_id: 'pid',
  ...extra,
});

describe('config parse + resolve', () => {
  it('applies Symphony custom-state defaults', () => {
    const c = resolveConfig(parseConfig({ tracker: planeTracker() }), '/tmp');
    expect(c.tracker.active_states).toContain('Rework');
    expect(c.tracker.active_states).toContain('Merging');
    expect(c.tracker.terminal_states).toContain('Done');
    expect(c.agent.backend).toBe('claude-sdk');
    expect(c.agent.permission_mode).toBe('bypassPermissions');
  });

  it('resolves $VAR for api_key and falls back to PLANE_API_KEY for plane', () => {
    process.env['SYMPHONY_TEST_TOKEN'] = 'tok-123';
    const c = resolveConfig(
      parseConfig({ tracker: planeTracker({ api_key: '$SYMPHONY_TEST_TOKEN' }) }),
      '/tmp',
    );
    expect(c.tracker.api_key).toBe('tok-123');

    process.env['PLANE_API_KEY'] = 'fallback';
    const c2 = resolveConfig(parseConfig({ tracker: planeTracker() }), '/tmp');
    expect(c2.tracker.api_key).toBe('fallback');
  });

  it('resolves $VAR for plane endpoint/workspace_slug/project_id and keeps endpoint un-defaulted', () => {
    process.env['SYMPHONY_TEST_TOKEN'] = 'http://plane.local';
    const c = resolveConfig(
      parseConfig({ tracker: planeTracker({ endpoint: '$SYMPHONY_TEST_TOKEN' }) }),
      '/tmp',
    );
    expect(c.tracker.endpoint).toBe('http://plane.local');
    // memory tracker has no endpoint and is not given a Linear default
    const mem = resolveConfig(parseConfig({ tracker: { kind: 'memory' } }), '/tmp');
    expect(mem.tracker.endpoint).toBeUndefined();
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

  it('defaults agent.tmux to false and logs_root to an absolute tmpdir path', () => {
    const c = resolveConfig(parseConfig({ tracker: { kind: 'memory' } }), '/tmp');
    expect(c.agent.tmux).toBe(false);
    expect(c.logs_root).toMatch(/symphony_logs$/);
    expect(c.logs_root.startsWith('/')).toBe(true);
  });

  it('expands ~/$VAR and absolutizes logs_root', () => {
    process.env['SYMPHONY_TEST_TOKEN'] = 'logs-here';
    const fromVar = resolveConfig(
      parseConfig({ tracker: { kind: 'memory' }, logs_root: '$SYMPHONY_TEST_TOKEN' }),
      '/base',
    );
    expect(fromVar.logs_root).toBe('/base/logs-here');
    const rel = resolveConfig(
      parseConfig({ tracker: { kind: 'memory' }, logs_root: 'mylogs' }),
      '/base',
    );
    expect(rel.logs_root).toBe('/base/mylogs');
  });
});
