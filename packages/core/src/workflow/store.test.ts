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

describe('WorkflowStore allowMissing (zero-config)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-store-zc-'));
    file = path.join(dir, 'WORKFLOW.md'); // intentionally NOT created
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads defaults when the file is missing', async () => {
    const store = new WorkflowStore(file, { allowMissing: true });
    const snap = await store.load();
    expect(snap.config.tracker.kind).toBe('file');
    expect(snap.config.workspace.mode).toBe('single_dir');
    expect(snap.promptBody).toBe('');
  });

  it('still throws on a missing file without allowMissing', async () => {
    const store = new WorkflowStore(file);
    await expect(store.load()).rejects.toThrow();
  });

  it('loads a file that appears after starting with defaults', async () => {
    const store = new WorkflowStore(file, { allowMissing: true });
    await store.load();
    await writeFile(file, VALID_2);
    await store.reloadNow();
    expect(store.snapshot().config.polling.interval_ms).toBe(9999);
    expect(store.snapshot().promptBody).toBe('Updated prompt');
  });

  it('keeps last-known-good after a loaded file is deleted (no revert to defaults)', async () => {
    await writeFile(file, VALID);
    const store = new WorkflowStore(file, { allowMissing: true });
    await store.load();
    expect(store.snapshot().config.polling.interval_ms).toBe(5000);
    await rm(file, { force: true });
    await store.reloadNow();
    expect(store.snapshot().config.polling.interval_ms).toBe(5000);
  });

  it('keeps a non-ENOENT read error fatal even with allowMissing', async () => {
    // Point at the directory itself → EISDIR on read, which must not be masked as "missing".
    const store = new WorkflowStore(dir, { allowMissing: true });
    await expect(store.load()).rejects.toThrow();
  });

  it('persist creates the file from defaults (first-write)', async () => {
    const store = new WorkflowStore(file, { allowMissing: true });
    await store.load();
    const snap = await store.persist((raw) => {
      raw['polling'] = { interval_ms: 4242 };
    });
    expect(snap.config.polling.interval_ms).toBe(4242);
    expect(await readFile(file, 'utf8')).toContain('interval_ms: 4242');
  });

  it('persist adopts a file created in the race window instead of clobbering it', async () => {
    const store = new WorkflowStore(file, { allowMissing: true });
    await store.load(); // defaults; stamp is the missing sentinel
    // Simulate `init`/an editor creating the file before our first persist.
    await writeFile(file, VALID_2);
    const snap = await store.persist((raw) => {
      (raw['polling'] as Record<string, unknown>).interval_ms = 1234;
    });
    // The racing file's body is preserved and our mutation is applied on top of it.
    expect(snap.promptBody).toBe('Updated prompt');
    expect(snap.config.polling.interval_ms).toBe(1234);
  });
});
