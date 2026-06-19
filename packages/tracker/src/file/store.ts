import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { IssueActivity, IssueComment, LabelInfo, WorkflowStateInfo } from '../tracker.js';

/**
 * On-disk per-issue JSON store for the `file` tracker. One directory per project under
 * `<dataRoot>/projects/<projectKey>/`:
 *
 *   meta.json              { identifier, next_seq }  ← single source of truth for ids
 *   states.json            WorkflowStateInfo[]       (display: lane order + type/color)
 *   labels.json            LabelInfo[]
 *   issues/<ID>.json       StoredIssue
 *   issues/<ID>/comments.jsonl   IssueComment per line
 *   issues/<ID>/activity.jsonl   IssueActivity per line
 *   uploads/<uuid>/<file>  attachment bytes
 *
 * Concurrency: writes are atomic (temp-in-same-dir + rename) and read-modify-write ops are
 * serialized through a per-key in-process async mutex. In this app the orchestrator process is
 * the only writer (SDK tools in-process; CLI tools via the Unix-socket bridge), so a single
 * process-local mutex is sufficient — no cross-process file locking. Readers tolerate a missing
 * or corrupt single file (skip + warn) and a trailing partial jsonl line (drop it).
 */

const metaSchema = z.object({ identifier: z.string(), next_seq: z.number().int().nonnegative() });
export type StoreMeta = z.infer<typeof metaSchema>;

const workflowStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number(),
  color: z.string().optional(),
});

const labelSchema = z.object({ id: z.string(), name: z.string() });

const blockerSchema = z.object({ id: z.string(), identifier: z.string(), state: z.string() });

const attachmentSchema = z.object({ url: z.string(), title: z.string() });

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number().optional(),
  updatedAt: z.string(),
});

const storedIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.number().nullable(),
  state: z.string(),
  branchName: z.string().nullable(),
  url: z.string().nullable(),
  labels: z.array(z.string()),
  blockedBy: z.array(blockerSchema),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  attachments: z.array(attachmentSchema).optional(),
  /** Per-task agent overrides (fall back to global agent config when absent). */
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Cumulative token/cost usage accrued by the agent on this task (absent when none). */
  usage: usageSchema.optional(),
});
export type StoredIssue = z.infer<typeof storedIssueSchema>;

const commentSchema = z.object({ at: z.string(), body: z.string() });
const activitySchema = z.object({
  at: z.string(),
  field: z.string().nullable(),
  verb: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
});

export interface FileStoreSeed {
  identifier: string;
  states: WorkflowStateInfo[];
  labels?: LabelInfo[];
}

export interface FileStoreOptions {
  dataRoot: string;
  projectKey: string;
  seed: FileStoreSeed;
  /** Called when a single file is missing/corrupt and skipped (non-fatal). */
  onWarn?: (msg: string) => void;
}

/** A project key must be one safe path segment (no separators, no traversal). */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === code;
}

const noop = (): void => {};

/**
 * Process-wide per-file async mutex. Keyed by absolute file path so multiple FileStore instances
 * over the same files in one process — e.g. the orchestrator's tracker and the SDK MCP executors'
 * tracker — still serialize their read-modify-write ops. (Cross-process CLI agents funnel through
 * the orchestrator's Unix-socket bridge, so they end up in this same process too.)
 */
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(noop, noop);
  fileLocks.set(key, tail);
  void tail.then(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  });
  return run;
}

/** Write `contents` to `file` atomically (temp file in the same dir, then rename). */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(tmp, contents, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export class FileStore {
  readonly projectKey: string;
  readonly projectDir: string;
  private readonly issuesDir: string;
  private readonly uploadsDir: string;
  private readonly metaFile: string;
  private readonly statesFile: string;
  private readonly labelsFile: string;
  private readonly seed: FileStoreSeed;
  private readonly warn: (msg: string) => void;
  private ensured?: Promise<void>;

  constructor(opts: FileStoreOptions) {
    if (!SAFE_KEY.test(opts.projectKey) || opts.projectKey.includes('..'))
      throw new Error(`unsafe project key: ${opts.projectKey}`);
    this.projectKey = opts.projectKey;
    this.projectDir = path.join(opts.dataRoot, 'projects', opts.projectKey);
    this.issuesDir = path.join(this.projectDir, 'issues');
    this.uploadsDir = path.join(this.projectDir, 'uploads');
    this.metaFile = path.join(this.projectDir, 'meta.json');
    this.statesFile = path.join(this.projectDir, 'states.json');
    this.labelsFile = path.join(this.projectDir, 'labels.json');
    this.seed = opts.seed;
    this.warn = opts.onWarn ?? noop;
  }

  private issueFile(id: string): string {
    return path.join(this.issuesDir, `${id}.json`);
  }
  private issueSubdir(id: string): string {
    return path.join(this.issuesDir, id);
  }

  /** Create the project dirs + seed meta/states/labels if absent (idempotent, cached). */
  ensureProject(): Promise<void> {
    return (this.ensured ??= this.doEnsure());
  }

  private async doEnsure(): Promise<void> {
    await fs.mkdir(this.issuesDir, { recursive: true });
    await fs.mkdir(this.uploadsDir, { recursive: true });
    await this.writeIfAbsent(
      this.metaFile,
      JSON.stringify(
        { identifier: this.seed.identifier, next_seq: 1 } satisfies StoreMeta,
        null,
        2,
      ),
    );
    await this.writeIfAbsent(this.statesFile, JSON.stringify(this.seed.states, null, 2));
    await this.writeIfAbsent(this.labelsFile, JSON.stringify(this.seed.labels ?? [], null, 2));
    await this.ensureSeedStates();
  }

  /**
   * Additively reconcile states.json with the seeded state set so a newly-added lane (e.g. Backlog)
   * appears in already-created projects too. Preserves every existing entry, its data, and order;
   * inserts each missing seed state at its seed-order position (Backlog at index 0 → leftmost);
   * never removes operator-added states. Reassigns `position` to the array index. Idempotent — a
   * no-op once nothing is missing.
   */
  private async ensureSeedStates(): Promise<void> {
    const seed = this.seed.states;
    if (seed.length === 0) return;
    await withFileLock(this.statesFile, async () => {
      const existing = (await this.readJson(this.statesFile, z.array(workflowStateSchema))) ?? [];
      const have = new Set(existing.map((s) => s.name));
      const missing = seed.filter((s) => !have.has(s.name));
      if (missing.length === 0) return;
      const seedIdx = (name: string): number => seed.findIndex((s) => s.name === name);
      const result: WorkflowStateInfo[] = existing.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        position: s.position,
        ...(s.color !== undefined ? { color: s.color } : {}),
      }));
      // Insert each missing seed state before the first existing state that follows it in seed order
      // (so Backlog, seed index 0, lands leftmost); append when no later seed-known state is present.
      for (const ms of missing) {
        const msIdx = seedIdx(ms.name);
        const at = result.findIndex((r) => {
          const ri = seedIdx(r.name);
          return ri !== -1 && ri > msIdx;
        });
        if (at === -1) result.push(ms);
        else result.splice(at, 0, ms);
      }
      const reindexed = result.map((s, i) => ({ ...s, position: i }));
      await writeFileAtomic(this.statesFile, JSON.stringify(reindexed, null, 2));
    });
  }

  /** Atomic create-if-absent via the `wx` flag (never clobbers operator/seed edits). */
  private async writeIfAbsent(file: string, contents: string): Promise<void> {
    try {
      await fs.writeFile(file, contents, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      if (!isErrno(e, 'EEXIST')) throw e;
    }
  }

  private async readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return null;
      throw e;
    }
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      this.warn(`file store: ignoring corrupt ${file}`);
      return null;
    }
  }

  private async readJsonl<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return [];
      throw e;
    }
    const out: T[] = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (s.length === 0) continue;
      try {
        out.push(schema.parse(JSON.parse(s)));
      } catch {
        // drop a corrupt / trailing-partial line
      }
    }
    return out;
  }

  // ---- meta / counter ----

  async readMeta(): Promise<StoreMeta> {
    await this.ensureProject();
    const meta = await this.readJson(this.metaFile, metaSchema);
    if (!meta)
      throw new Error(`file store: meta.json missing or corrupt for project ${this.projectKey}`);
    return meta;
  }

  /**
   * Reserve the next issue id — the identifier prefix + sequence number, read-increment-write under
   * the meta lock. meta.json is the single source of truth for both (front-matter only seeds it).
   */
  async reserveId(): Promise<{ identifier: string; seq: number }> {
    await this.ensureProject();
    return withFileLock(this.metaFile, async () => {
      const meta = await this.readJson(this.metaFile, metaSchema);
      if (!meta)
        throw new Error(`file store: meta.json missing or corrupt for project ${this.projectKey}`);
      await writeFileAtomic(
        this.metaFile,
        JSON.stringify({ ...meta, next_seq: meta.next_seq + 1 }, null, 2),
      );
      return { identifier: meta.identifier, seq: meta.next_seq };
    });
  }

  // ---- issues ----

  async readIssue(id: string): Promise<StoredIssue | null> {
    await this.ensureProject();
    return this.readJson(this.issueFile(id), storedIssueSchema);
  }

  async listIssues(): Promise<StoredIssue[]> {
    await this.ensureProject();
    let names: string[];
    try {
      names = await fs.readdir(this.issuesDir);
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return [];
      throw e;
    }
    const out: StoredIssue[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const issue = await this.readJson(path.join(this.issuesDir, name), storedIssueSchema);
      if (issue) out.push(issue);
    }
    return out;
  }

  /** Write a brand-new issue. Its id is unique (minted from reserveId) so no lock is needed. */
  async putNewIssue(issue: StoredIssue): Promise<void> {
    await this.ensureProject();
    await writeFileAtomic(this.issueFile(issue.id), JSON.stringify(issue, null, 2));
  }

  /** Read-modify-write one issue under its file lock. Throws if the issue does not exist. */
  async mutateIssue(id: string, fn: (issue: StoredIssue) => StoredIssue): Promise<StoredIssue> {
    await this.ensureProject();
    return withFileLock(this.issueFile(id), async () => {
      const issue = await this.readJson(this.issueFile(id), storedIssueSchema);
      if (!issue) throw new Error(`issue ${id} not found`);
      const next = fn(issue);
      await writeFileAtomic(this.issueFile(id), JSON.stringify(next, null, 2));
      return next;
    });
  }

  /**
   * Permanently delete an issue: its `<ID>.json` and the `<ID>/` subdir (comments + activity).
   * Throws if the issue file does not exist. Taken under the issue's file lock so a concurrent
   * mutate/read can't interleave.
   */
  async deleteIssue(id: string): Promise<void> {
    await this.ensureProject();
    await withFileLock(this.issueFile(id), async () => {
      try {
        await fs.rm(this.issueFile(id));
      } catch (e) {
        if (isErrno(e, 'ENOENT')) throw new Error(`issue ${id} not found`);
        throw e;
      }
      await fs.rm(this.issueSubdir(id), { recursive: true, force: true });
    });
  }

  // ---- states / labels ----

  async readStates(): Promise<WorkflowStateInfo[]> {
    await this.ensureProject();
    const parsed = (await this.readJson(this.statesFile, z.array(workflowStateSchema))) ?? [];
    // zod `.optional()` widens color to `string | undefined`; spread it only when present so the
    // result satisfies WorkflowStateInfo under exactOptionalPropertyTypes.
    return parsed.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      position: s.position,
      ...(s.color !== undefined ? { color: s.color } : {}),
    }));
  }

  async readLabels(): Promise<LabelInfo[]> {
    await this.ensureProject();
    return (await this.readJson(this.labelsFile, z.array(labelSchema))) ?? [];
  }

  // ---- comments / activity ----

  async appendComment(id: string, comment: IssueComment): Promise<void> {
    await this.ensureProject();
    await fs.mkdir(this.issueSubdir(id), { recursive: true });
    await fs.appendFile(
      path.join(this.issueSubdir(id), 'comments.jsonl'),
      `${JSON.stringify(comment)}\n`,
      'utf8',
    );
  }

  async readComments(id: string): Promise<IssueComment[]> {
    await this.ensureProject();
    return this.readJsonl(path.join(this.issueSubdir(id), 'comments.jsonl'), commentSchema);
  }

  async appendActivity(id: string, activity: IssueActivity): Promise<void> {
    await this.ensureProject();
    await fs.mkdir(this.issueSubdir(id), { recursive: true });
    await fs.appendFile(
      path.join(this.issueSubdir(id), 'activity.jsonl'),
      `${JSON.stringify(activity)}\n`,
      'utf8',
    );
  }

  async readActivity(id: string): Promise<IssueActivity[]> {
    await this.ensureProject();
    return this.readJsonl(path.join(this.issueSubdir(id), 'activity.jsonl'), activitySchema);
  }

  // ---- uploads ----

  /** Write attachment bytes; returns the dashboard-served asset URL. */
  async writeUpload(filename: string, data: Buffer): Promise<string> {
    await this.ensureProject();
    const uid = randomUUID();
    const dir = path.join(this.uploadsDir, uid);
    await fs.mkdir(dir, { recursive: true });
    const safeName = path.basename(filename) || 'file';
    await fs.writeFile(path.join(dir, safeName), data);
    return `/api/v1/uploads/${encodeURIComponent(this.projectKey)}/${uid}/${encodeURIComponent(safeName)}`;
  }
}

/** List the project keys that have a directory under `<dataRoot>/projects/`. */
export async function listProjectKeys(dataRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(dataRoot, 'projects'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return [];
    throw e;
  }
}

/** Scaffold (create + seed) a project directory. Idempotent. */
export async function scaffoldProject(opts: FileStoreOptions): Promise<void> {
  await new FileStore(opts).ensureProject();
}
