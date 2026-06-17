import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearDetectionCache, detectAgent, detectedCapabilities } from './detect.js';

afterEach(() => clearDetectionCache());

describe('detectAgent', () => {
  it('reports found:false for a missing binary', async () => {
    const r = await detectAgent({ binary: 'definitely-not-a-real-binary-xyz-123' });
    expect(r.found).toBe(false);
    expect(r.capabilities).toEqual({ partialMessages: false, addDir: false });
  });

  it('finds a binary on PATH', async () => {
    const r = await detectAgent({ binary: 'sh' });
    expect(r.found).toBe(true);
    expect((r.path ?? '').length).toBeGreaterThan(0);
  });

  it('probes capability flags from --help and caches them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'symphony-detect-'));
    const bin = path.join(dir, 'fake-agent.sh');
    // Ignores args; prints a version line + a help line advertising one of the two flags.
    await writeFile(
      bin,
      `#!/bin/sh\necho "fake 1.2.3"\necho "  --include-partial-messages  live"\n`,
    );
    await chmod(bin, 0o755);

    const r = await detectAgent({
      binary: bin,
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      capabilityFlags: {
        '--include-partial-messages': 'partialMessages',
        '--add-dir': 'addDir',
      },
    });

    expect(r.found).toBe(true);
    expect(r.version).toBe('fake 1.2.3');
    expect(r.capabilities.partialMessages).toBe(true);
    expect(r.capabilities.addDir).toBe(false);
    expect(detectedCapabilities(bin)?.partialMessages).toBe(true);
  });
});
