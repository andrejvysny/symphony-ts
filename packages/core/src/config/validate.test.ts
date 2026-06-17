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
  it('passes for a fully-configured plane tracker', () => {
    const cfg = build({
      kind: 'plane',
      api_key: 'k',
      endpoint: 'http://localhost',
      workspace_slug: 'ws',
      project_id: 'pid',
    });
    const r = dispatchPreflight(cfg);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports every missing plane field', () => {
    const cfg = build({ kind: 'plane' });
    const r = dispatchPreflight(cfg);
    expect(r.ok).toBe(false);
    const joined = r.errors.join(' ');
    expect(joined).toMatch(/api_key/);
    expect(joined).toMatch(/endpoint/);
    expect(joined).toMatch(/workspace_slug/);
    expect(joined).toMatch(/project_id/);
  });

  it('rejects the removed linear kind as unsupported', () => {
    const r = dispatchPreflight(build({ kind: 'linear' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not supported/);
  });

  it('memory tracker needs only a repo', () => {
    expect(dispatchPreflight(build({ kind: 'memory' })).ok).toBe(true);
    const noRepo = dispatchPreflight(build({ kind: 'memory' }, null));
    expect(noRepo.ok).toBe(false);
    expect(noRepo.errors.join(' ')).toMatch(/workspace\.repo/);
  });
});
