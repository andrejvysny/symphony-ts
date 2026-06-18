import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, resolveConfig } from './resolve.js';

afterEach(() => {
  delete process.env['SYMPHONY_TEST_TOKEN'];
});

describe('config parse + resolve', () => {
  it('applies Symphony custom-state defaults', () => {
    const c = resolveConfig(parseConfig({ tracker: { kind: 'file' } }), '/tmp');
    // Simplified workflow: lanes are Todo + In Progress (rework/merging are no longer states).
    expect(c.tracker.active_states).toEqual(['Todo', 'In Progress']);
    expect(c.tracker.terminal_states).toContain('Done');
    expect(c.workspace.mode).toBe('single_dir');
    expect(c.agent.backend).toBe('claude-sdk');
    expect(c.agent.permission_mode).toBe('bypassPermissions');
  });

  it('defaults tracker.kind to file and data_root to ~/.symphony', () => {
    const c = resolveConfig(parseConfig({}), '/tmp');
    expect(c.tracker.kind).toBe('file');
    expect(c.tracker.data_root).toBe(path.join(os.homedir(), '.symphony'));
  });

  it('resolves $VAR for project_id and ~/$VAR for data_root', () => {
    process.env['SYMPHONY_TEST_TOKEN'] = 'proj-x';
    const c = resolveConfig(
      parseConfig({
        tracker: { kind: 'file', project_id: '$SYMPHONY_TEST_TOKEN', data_root: '~/store' },
      }),
      '/base',
    );
    expect(c.tracker.project_id).toBe('proj-x');
    expect(c.tracker.data_root).toBe(path.join(os.homedir(), 'store'));
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
