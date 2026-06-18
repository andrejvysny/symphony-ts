import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore, type FileStoreOptions, listProjectKeys, scaffoldProject } from './store.js';

const SEED = {
  identifier: 'SYM',
  states: [{ id: 'Todo', name: 'Todo', type: 'unstarted', position: 0 }],
};

describe('FileStore', () => {
  let root: string;
  const opts = (extra: Partial<FileStoreOptions> = {}): FileStoreOptions => ({
    dataRoot: root,
    projectKey: 'demo',
    seed: SEED,
    ...extra,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-fs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects an unsafe project key', () => {
    expect(() => new FileStore(opts({ projectKey: '../escape' }))).toThrow(/unsafe project key/);
  });

  it('scaffolds + seeds meta/states/labels idempotently', async () => {
    const store = new FileStore(opts());
    await store.ensureProject();
    await store.ensureProject(); // idempotent
    expect((await store.readMeta()).next_seq).toBe(1);
    expect((await store.readStates()).map((s) => s.name)).toEqual(['Todo']);
    expect(await store.readLabels()).toEqual([]);
  });

  it('mints monotonic ids that persist across instances and carry the identifier', async () => {
    const a = new FileStore(opts());
    expect(await a.reserveId()).toEqual({ identifier: 'SYM', seq: 1 });
    expect((await a.reserveId()).seq).toBe(2);
    const b = new FileStore(opts()); // fresh instance, same dir
    expect((await b.reserveId()).seq).toBe(3);
  });

  it('mints distinct sequence numbers under concurrency', async () => {
    const store = new FileStore(opts());
    const ns = await Promise.all(Array.from({ length: 20 }, () => store.reserveId()));
    expect(new Set(ns.map((r) => r.seq)).size).toBe(20);
    expect((await store.readMeta()).next_seq).toBe(21);
  });

  it('writes issues atomically and reads them back; ignores stray non-json files', async () => {
    const store = new FileStore(opts());
    await store.putNewIssue({
      id: 'SYM-1',
      identifier: 'SYM-1',
      title: 'one',
      description: null,
      priority: null,
      state: 'Todo',
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    });
    await writeFile(path.join(store.projectDir, 'issues', 'leftover.tmp'), 'not json');
    const all = await store.listIssues();
    expect(all.map((i) => i.id)).toEqual(['SYM-1']);
  });

  it('skips a corrupt issue file and warns instead of throwing', async () => {
    const warnings: string[] = [];
    const store = new FileStore(opts({ onWarn: (m) => warnings.push(m) }));
    await store.ensureProject();
    await writeFile(path.join(store.projectDir, 'issues', 'SYM-9.json'), '{ broken');
    expect(await store.listIssues()).toEqual([]);
    expect(await store.readIssue('SYM-9')).toBeNull();
    expect(warnings.some((w) => w.includes('SYM-9.json'))).toBe(true);
  });

  it('mutateIssue throws on a missing issue', async () => {
    const store = new FileStore(opts());
    await expect(store.mutateIssue('SYM-404', (i) => i)).rejects.toThrow(/not found/);
  });

  it('appends + reads jsonl, dropping a trailing partial line; missing → []', async () => {
    const store = new FileStore(opts());
    expect(await store.readComments('SYM-1')).toEqual([]);
    await store.appendComment('SYM-1', { at: 't1', body: 'first' });
    await store.appendComment('SYM-1', { at: 't2', body: 'second' });
    // simulate a torn trailing line from an interrupted append
    await writeFile(
      path.join(store.projectDir, 'issues', 'SYM-1', 'comments.jsonl'),
      `${JSON.stringify({ at: 't1', body: 'first' })}\n{ "at": "t2", "bo`,
      'utf8',
    );
    const comments = await store.readComments('SYM-1');
    expect(comments).toEqual([{ at: 't1', body: 'first' }]);
  });

  it('stores uploads and returns a project-scoped served url', async () => {
    const store = new FileStore(opts());
    const url = await store.writeUpload('repro log.txt', Buffer.from('hello'));
    expect(url).toMatch(/^\/api\/v1\/uploads\/demo\/[0-9a-f-]+\/repro%20log\.txt$/);
    const rel = decodeURI(url.replace('/api/v1/uploads/demo/', ''));
    expect(await readFile(path.join(store.projectDir, 'uploads', rel), 'utf8')).toBe('hello');
  });

  it('readMeta throws on a corrupt meta.json', async () => {
    const store = new FileStore(opts());
    await store.ensureProject();
    await writeFile(path.join(store.projectDir, 'meta.json'), 'nope');
    await expect(store.readMeta()).rejects.toThrow(/missing or corrupt/);
  });

  it('lists project keys; scaffoldProject creates one', async () => {
    expect(await listProjectKeys(root)).toEqual([]);
    await scaffoldProject(opts({ projectKey: 'alpha' }));
    await scaffoldProject(opts({ projectKey: 'beta' }));
    expect((await listProjectKeys(root)).sort()).toEqual(['alpha', 'beta']);
  });
});
