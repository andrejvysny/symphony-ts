import { describe, expect, it } from 'vitest';
import { parseConfig, resolveConfig } from './resolve.js';
import { dispatchPreflight } from './validate.js';

function build(tracker: Record<string, unknown>, repo: string | null = '/tmp/repo') {
  return resolveConfig(
    parseConfig({ tracker, ...(repo !== null ? { workspace: { repo } } : {}) }),
    '/tmp',
  );
}

describe('dispatchPreflight', () => {
  it('passes for the file tracker with a repo', () => {
    const r = dispatchPreflight(build({ kind: 'file', project_id: 'demo' }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects an unsupported tracker kind', () => {
    const r = dispatchPreflight(build({ kind: 'plane' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not supported/);
  });

  it('file/memory trackers need only a repo', () => {
    expect(dispatchPreflight(build({ kind: 'file' })).ok).toBe(true);
    expect(dispatchPreflight(build({ kind: 'memory' })).ok).toBe(true);
    const noRepo = dispatchPreflight(build({ kind: 'file' }, null));
    expect(noRepo.ok).toBe(false);
    expect(noRepo.errors.join(' ')).toMatch(/workspace\.repo/);
  });

  it('single_dir mode rejects a remote workspace.repo (worktree allows it)', () => {
    const single = resolveConfig(
      parseConfig({
        tracker: { kind: 'file' },
        workspace: { mode: 'single_dir', repo: 'git@github.com:o/r.git' },
      }),
      '/tmp',
    );
    const r = dispatchPreflight(single);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/single_dir/);

    const worktree = resolveConfig(
      parseConfig({
        tracker: { kind: 'file' },
        workspace: { mode: 'worktree', repo: 'git@github.com:o/r.git' },
      }),
      '/tmp',
    );
    expect(dispatchPreflight(worktree).ok).toBe(true);
  });

  it('fails when the agent binary was not detected (D1)', () => {
    const cfg = build({ kind: 'memory' });
    const missing = dispatchPreflight(cfg, { found: false, binary: 'claude' });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toMatch(/binary "claude" not found/);
    // A successful detection (or none) does not block.
    expect(dispatchPreflight(cfg, { found: true, binary: 'claude' }).ok).toBe(true);
    expect(dispatchPreflight(cfg).ok).toBe(true);
  });
});
