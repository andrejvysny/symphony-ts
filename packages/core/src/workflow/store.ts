import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '@symphony/shared';
import type { SymphonyConfig } from '../config/resolve.js';
import { parseConfig, resolveConfig } from '../config/resolve.js';
import { type Logger, noopLogger } from '../observability/logger.js';
import { parseWorkflowFile, serializeWorkflowFile } from './loader.js';

/** Mutator applied to the raw (pre-resolution) front-matter map before writing it back. */
export type RawFrontMatter = Record<string, unknown>;
export type ConfigMutator = (raw: RawFrontMatter) => void;

export interface WorkflowSnapshot {
  config: SymphonyConfig;
  promptBody: string;
}

interface Stamp {
  mtimeMs: number;
  size: number;
  hash: string;
}

/**
 * Loads WORKFLOW.md and hot-reloads it on change (SPEC §6.2). Detection is a 1s
 * stat-poll on mtime+size+content-hash. An invalid reload keeps the last-known-good
 * snapshot and logs an operator-visible error — it never throws after initial load.
 */
export class WorkflowStore {
  private current: WorkflowSnapshot | undefined;
  private stamp: Stamp | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Raw (pre-resolution) front-matter from the last read — the basis for write-back. */
  private rawFrontMatter: RawFrontMatter = {};
  private body = '';

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger = noopLogger,
    private readonly pollMs = 1_000,
  ) {}

  /** Initial load — throws (fatal at startup) if the file is missing/invalid. */
  async load(): Promise<WorkflowSnapshot> {
    const { snapshot, stamp, raw, body } = await this.read();
    this.current = snapshot;
    this.stamp = stamp;
    this.rawFrontMatter = raw;
    this.body = body;
    return snapshot;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkReload();
    }, this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): WorkflowSnapshot {
    if (!this.current) throw new ConfigError('WorkflowStore.load() must run before snapshot()');
    return this.current;
  }

  /** Force a reload check now (used by tests and operational triggers). */
  async reloadNow(): Promise<void> {
    await this.checkReload();
  }

  /**
   * Apply `mutate` to a clone of the current raw front matter and return the resolved config,
   * WITHOUT writing to disk. Throws (ZodError) if the mutation produces an invalid config —
   * callers use this to validate + preview a change before committing it via {@link persist}.
   */
  composeConfig(mutate: ConfigMutator): SymphonyConfig {
    const raw = structuredClone(this.rawFrontMatter);
    mutate(raw);
    return resolveConfig(parseConfig(raw), path.dirname(path.resolve(this.filePath)));
  }

  /**
   * Mutate the raw front matter and write it back to WORKFLOW.md (preserving the prompt body and
   * `$VAR` indirection), then refresh the in-memory snapshot + stamp so the 1s poll doesn't
   * double-reload. Returns the new snapshot.
   */
  async persist(mutate: ConfigMutator): Promise<WorkflowSnapshot> {
    const raw = structuredClone(this.rawFrontMatter);
    mutate(raw);
    // Validate before writing so a bad mutation never lands on disk.
    resolveConfig(parseConfig(raw), path.dirname(path.resolve(this.filePath)));
    const content = serializeWorkflowFile(raw, this.body);
    await writeFile(path.resolve(this.filePath), content, 'utf8');
    const { snapshot, stamp, raw: freshRaw, body } = await this.read();
    this.current = snapshot;
    this.stamp = stamp;
    this.rawFrontMatter = freshRaw;
    this.body = body;
    return snapshot;
  }

  private async read(): Promise<{
    snapshot: WorkflowSnapshot;
    stamp: Stamp;
    raw: RawFrontMatter;
    body: string;
  }> {
    const abs = path.resolve(this.filePath);
    let content: string;
    let st;
    try {
      st = await stat(abs);
      content = await readFile(abs, 'utf8');
    } catch (e) {
      throw new ConfigError(`cannot read workflow file ${abs}: ${(e as Error).message}`);
    }
    const hash = createHash('sha1').update(content).digest('hex');
    const { frontMatter, promptBody } = parseWorkflowFile(content);
    const config = resolveConfig(parseConfig(frontMatter), path.dirname(abs));
    return {
      snapshot: { config, promptBody },
      stamp: { mtimeMs: st.mtimeMs, size: st.size, hash },
      raw: (frontMatter ?? {}) as RawFrontMatter,
      body: promptBody,
    };
  }

  private async checkReload(): Promise<void> {
    const abs = path.resolve(this.filePath);
    let st;
    try {
      st = await stat(abs);
    } catch (e) {
      this.logger.error({ error: String(e) }, 'workflow file stat failed; keeping last config');
      return;
    }
    if (this.stamp && st.mtimeMs === this.stamp.mtimeMs && st.size === this.stamp.size) return;

    try {
      const { snapshot, stamp, raw, body } = await this.read();
      if (this.stamp && stamp.hash === this.stamp.hash) {
        this.stamp = stamp; // touched but unchanged content
        return;
      }
      this.current = snapshot;
      this.stamp = stamp;
      this.rawFrontMatter = raw;
      this.body = body;
      this.logger.info({ file: abs }, 'workflow reloaded');
    } catch (e) {
      this.logger.error(
        { error: String(e), file: abs },
        'workflow reload failed; keeping last-known-good config',
      );
    }
  }
}
