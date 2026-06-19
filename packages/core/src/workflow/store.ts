import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

/** Stamp of a not-yet-created file when `allowMissing` is on (zero-config run). */
const MISSING_STAMP: Stamp = { mtimeMs: 0, size: 0, hash: '' };

/**
 * Loads WORKFLOW.md and hot-reloads it on change (SPEC §6.2). Detection is a 1s
 * stat-poll on mtime+size+content-hash. An invalid reload keeps the last-known-good
 * snapshot and logs an operator-visible error — it never throws after initial load.
 *
 * With `allowMissing` (zero-config run), a MISSING file (ENOENT only — perms/other errors stay
 * fatal) yields the default config + empty prompt body instead of throwing, so `symphony --port`
 * works with no WORKFLOW.md; the dashboard then creates one via {@link persist}. Once a real file
 * has been loaded, a later deletion retains the last-known-good config (never reverts to defaults).
 */
export class WorkflowStore {
  private current: WorkflowSnapshot | undefined;
  private stamp: Stamp | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Raw (pre-resolution) front-matter from the last read — the basis for write-back. */
  private rawFrontMatter: RawFrontMatter = {};
  private body = '';
  private readonly logger: Logger;
  private readonly pollMs: number;
  private readonly allowMissing: boolean;

  constructor(
    private readonly filePath: string,
    opts: { logger?: Logger; pollMs?: number; allowMissing?: boolean } = {},
  ) {
    this.logger = opts.logger ?? noopLogger;
    this.pollMs = opts.pollMs ?? 1_000;
    this.allowMissing = opts.allowMissing ?? false;
  }

  /** Initial load. Throws (fatal at startup) if the file is missing/invalid — unless `allowMissing`,
   *  where a missing file loads defaults. */
  async load(): Promise<WorkflowSnapshot> {
    return this.refresh();
  }

  /** Re-read from disk and replace the in-memory snapshot + stamp; returns the fresh snapshot. */
  private async refresh(): Promise<WorkflowSnapshot> {
    const { snapshot, stamp, raw, body } = await this.read();
    this.current = snapshot;
    this.stamp = stamp;
    this.rawFrontMatter = raw;
    this.body = body;
    return snapshot;
  }

  /** Whether we hold in-memory defaults for a not-yet-created file (zero-config pre-create state). */
  private isMissingStamp(): boolean {
    return this.stamp?.mtimeMs === 0 && this.stamp.size === 0;
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
    const abs = path.resolve(this.filePath);
    await mkdir(path.dirname(abs), { recursive: true });
    // Zero-config pre-create state: a WORKFLOW.md may have appeared (init/editor/another writer)
    // since we loaded defaults. Reconcile with disk first so we mutate fresh on-disk state, not the
    // stale in-memory `{}`, and never clobber that file.
    if (this.isMissingStamp()) {
      try {
        await this.refresh();
      } catch {
        /* still missing/unreadable → keep defaults and create below */
      }
    }
    // Build the serialized content from the CURRENT raw + body (validated before writing).
    const apply = (): string => {
      const raw = structuredClone(this.rawFrontMatter);
      mutate(raw);
      resolveConfig(parseConfig(raw), path.dirname(abs)); // throws on invalid → never lands on disk
      return serializeWorkflowFile(raw, this.body);
    };
    if (this.isMissingStamp()) {
      // First creation: exclusive write so a racing creator isn't overwritten.
      try {
        await writeFile(abs, apply(), { encoding: 'utf8', flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        await this.refresh(); // adopt the racing file, then reapply the mutation onto it
        await writeFile(abs, apply(), 'utf8');
      }
    } else {
      await writeFile(abs, apply(), 'utf8');
    }
    // Refresh the in-memory snapshot + stamp so the 1s poll doesn't double-reload.
    return this.refresh();
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
      // Zero-config run: a MISSING file (ENOENT only) → default config + empty prompt body.
      // Permission/other errors stay fatal so real misconfiguration isn't silently masked.
      if (this.allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        const config = resolveConfig(parseConfig({}), path.dirname(abs));
        return { snapshot: { config, promptBody: '' }, stamp: MISSING_STAMP, raw: {}, body: '' };
      }
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
      // Missing file → keep current config. With allowMissing this is the normal pre-create state
      // (don't spam logs); a file that was loaded then deleted also retains last-known-good.
      if (this.allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.logger.error({ error: String(e) }, 'workflow file stat failed; keeping last config');
      return;
    }
    if (this.stamp && st.mtimeMs === this.stamp.mtimeMs && st.size === this.stamp.size) return;

    try {
      const { snapshot, stamp, raw, body } = await this.read();
      // File vanished between stat and read (TOCTOU) → keep last-known-good, don't revert to defaults.
      if (stamp === MISSING_STAMP) return;
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
