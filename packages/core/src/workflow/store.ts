import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '@symphony/shared';
import type { SymphonyConfig } from '../config/resolve.js';
import { parseConfig, resolveConfig } from '../config/resolve.js';
import { type Logger, noopLogger } from '../observability/logger.js';
import { parseWorkflowFile } from './loader.js';

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

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger = noopLogger,
    private readonly pollMs = 1_000,
  ) {}

  /** Initial load — throws (fatal at startup) if the file is missing/invalid. */
  async load(): Promise<WorkflowSnapshot> {
    const { snapshot, stamp } = await this.read();
    this.current = snapshot;
    this.stamp = stamp;
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

  private async read(): Promise<{ snapshot: WorkflowSnapshot; stamp: Stamp }> {
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
      const { snapshot, stamp } = await this.read();
      if (this.stamp && stamp.hash === this.stamp.hash) {
        this.stamp = stamp; // touched but unchanged content
        return;
      }
      this.current = snapshot;
      this.stamp = stamp;
      this.logger.info({ file: abs }, 'workflow reloaded');
    } catch (e) {
      this.logger.error(
        { error: String(e), file: abs },
        'workflow reload failed; keeping last-known-good config',
      );
    }
  }
}
