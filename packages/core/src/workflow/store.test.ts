import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowStore } from './store.js';

const VALID = `---
tracker:
  kind: memory
workspace:
  repo: /tmp/r
polling:
  interval_ms: 5000
---
Work on {{ issue.identifier }}`;

const VALID_2 = `---
tracker:
  kind: memory
workspace:
  repo: /tmp/r
polling:
  interval_ms: 9999
---
Updated prompt`;

const INVALID = `---
tracker:
  bogus_key_that_is_not_allowed: true
  kind: memory
---
body`;

describe('WorkflowStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-store-'));
    file = path.join(dir, 'WORKFLOW.md');
    await writeFile(file, VALID);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads initial config + prompt body', async () => {
    const store = new WorkflowStore(file);
    const snap = await store.load();
    expect(snap.config.polling.interval_ms).toBe(5000);
    expect(snap.promptBody).toBe('Work on {{ issue.identifier }}');
  });

  it('hot-reloads on change', async () => {
    const store = new WorkflowStore(file);
    await store.load();
    await writeFile(file, VALID_2);
    await store.reloadNow();
    expect(store.snapshot().config.polling.interval_ms).toBe(9999);
    expect(store.snapshot().promptBody).toBe('Updated prompt');
  });

  it('keeps last-known-good on invalid reload', async () => {
    const store = new WorkflowStore(file);
    await store.load();
    await writeFile(file, INVALID);
    await store.reloadNow();
    // unchanged — still the original valid config
    expect(store.snapshot().config.polling.interval_ms).toBe(5000);
  });

  it('throws on invalid initial load', async () => {
    await writeFile(file, INVALID);
    const store = new WorkflowStore(file);
    await expect(store.load()).rejects.toThrow();
  });
});
