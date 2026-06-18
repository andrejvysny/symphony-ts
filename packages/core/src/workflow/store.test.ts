import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('composeConfig applies a mutation without writing the file', async () => {
    const store = new WorkflowStore(file);
    await store.load();
    const next = store.composeConfig((raw) => {
      (raw['polling'] as Record<string, unknown>).interval_ms = 12_345;
    });
    expect(next.polling.interval_ms).toBe(12_345);
    // file on disk is untouched + the in-memory snapshot is unchanged
    expect(await readFile(file, 'utf8')).toBe(VALID);
    expect(store.snapshot().config.polling.interval_ms).toBe(5000);
  });

  it('composeConfig throws on an invalid mutation', async () => {
    const store = new WorkflowStore(file);
    await store.load();
    expect(() =>
      store.composeConfig((raw) => {
        (raw['polling'] as Record<string, unknown>).interval_ms = -1; // must be positive
      }),
    ).toThrow();
  });

  it('persist writes the mutation, preserves the body + $VAR, and refreshes the snapshot', async () => {
    const withVar = `---
tracker:
  kind: memory
  data_root: $MY_DATA_ROOT
projects: []
workspace:
  repo: /tmp/r
polling:
  interval_ms: 5000
---
Keep this body`;
    await writeFile(file, withVar);
    const store = new WorkflowStore(file);
    await store.load();

    const snap = await store.persist((raw) => {
      const list = (raw['projects'] as unknown[]) ?? [];
      list.push({ name: 'Beta', project_id: 'p2', repo: '~/code/beta' });
      raw['projects'] = list;
      (raw['polling'] as Record<string, unknown>).interval_ms = 7777;
    });

    expect(snap.config.polling.interval_ms).toBe(7777);
    expect(snap.config.projects).toHaveLength(1);
    expect(store.snapshot().config.polling.interval_ms).toBe(7777);

    const onDisk = await readFile(file, 'utf8');
    expect(onDisk).toContain('$MY_DATA_ROOT'); // $VAR indirection NOT expanded on persist
    expect(onDisk).toContain('Keep this body'); // prompt body preserved
    expect(onDisk).toContain('project_id: p2');
  });

  it('persist rejects an invalid mutation before writing', async () => {
    const store = new WorkflowStore(file);
    await store.load();
    await expect(
      store.persist((raw) => {
        (raw['tracker'] as Record<string, unknown>).bogus = true; // strict schema rejects
      }),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(VALID); // file untouched
  });
});
