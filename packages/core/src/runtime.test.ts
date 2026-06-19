import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, resolveConfig, type SymphonyConfig } from './config/resolve.js';
import {
  buildMcpConfig,
  buildTracker,
  fileTrackerOptions,
  hasActiveProject,
  trackerSocketPath,
} from './runtime.js';

describe('runtime file tracker wiring', () => {
  let root: string;

  const cfg = (raw: Record<string, unknown>): SymphonyConfig =>
    resolveConfig(
      parseConfig({
        workspace: { repo: '/tmp/repo' },
        ...raw,
      }),
      root,
    );

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-rt-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('buildTracker returns a FileTracker for kind file and throws on unknown', () => {
    const t = buildTracker(cfg({ tracker: { kind: 'file', data_root: root, project_id: 'demo' } }));
    expect(t.kind).toBe('file');
    expect(buildTracker(cfg({ tracker: { kind: 'memory' } })).kind).toBe('memory');
    expect(() => buildTracker(cfg({ tracker: { kind: 'bogus' } }))).toThrow();
  });

  it('no active project → an inert NullTracker, no mcp config, and no implicit "default"', () => {
    const c = cfg({ tracker: { kind: 'file', data_root: root } }); // project_id unset
    expect(hasActiveProject(c)).toBe(false);
    const t = buildTracker(c);
    expect(t.kind).toBe('none');
    expect(buildMcpConfig(c)).toBeUndefined();
    expect(() => fileTrackerOptions(c)).toThrow(/no active project/);
    // A configured project is active and builds a real file tracker.
    const active = cfg({ tracker: { kind: 'file', data_root: root, project_id: 'demo' } });
    expect(hasActiveProject(active)).toBe(true);
    expect(buildTracker(active).kind).toBe('file');
  });

  it('fileTrackerOptions takes the identifier from the project registry', () => {
    const opts = fileTrackerOptions(
      cfg({
        tracker: { kind: 'file', data_root: root, project_id: 'acme' },
        projects: [{ name: 'Acme', project_id: 'acme', repo: '/tmp/repo', identifier: 'ACM' }],
      }),
    );
    expect(opts).toMatchObject({ projectKey: 'acme', identifier: 'ACM', dataRoot: root });
  });

  it('trackerSocketPath sits under data_root', () => {
    const sock = trackerSocketPath(cfg({ tracker: { kind: 'file', data_root: root } }));
    expect(sock).toBe(path.join(root, 'tracker.sock'));
  });

  it('buildMcpConfig (file + claude-sdk) returns an in-process sdk server factory', () => {
    const mcp = buildMcpConfig(
      cfg({
        tracker: { kind: 'file', data_root: root, project_id: 'demo' },
        agent: { backend: 'claude-sdk' },
      }),
    );
    expect(typeof mcp?.sdkServers).toBe('function');
    expect(Object.keys(mcp!.sdkServers!())).toContain('symphony');
  });

  it('buildMcpConfig (file + claude-cli) returns a stdio bridge-client spec', () => {
    const mcp = buildMcpConfig(
      cfg({
        tracker: { kind: 'file', data_root: root, project_id: 'demo' },
        agent: { backend: 'claude-cli' },
      }),
    );
    const server = mcp?.stdioServers?.['symphony'];
    expect(server?.command).toBe(process.execPath);
    expect(server?.env?.['SYMPHONY_TRACKER_SOCK']).toBe(path.join(root, 'tracker.sock'));
    expect(JSON.parse(server?.env?.['SYMPHONY_AGENT_STATES'] ?? '[]')).toContain('Human Review');
  });
});
