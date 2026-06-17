import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

/** Per-agent capabilities probed from `--help`, used to gate optional CLI flags. */
export interface AgentCapabilities {
  /** Supports `--include-partial-messages` (live streaming deltas). */
  partialMessages: boolean;
  /** Supports `--add-dir`. */
  addDir: boolean;
}

export interface DetectionResult {
  found: boolean;
  path?: string;
  version?: string;
  capabilities: AgentCapabilities;
}

export interface DetectOptions {
  /** Binary name (resolved on PATH) or an absolute/relative path. */
  binary: string;
  /** Args to read the version (best-effort). */
  versionArgs?: string[];
  /** Args to print help (probed for capability flags). */
  helpArgs?: string[];
  /** Help-substring → capability key. Each substring present in help sets that capability true. */
  capabilityFlags?: Record<string, keyof AgentCapabilities>;
}

const cache = new Map<string, DetectionResult>();

function emptyCaps(): AgentCapabilities {
  return { partialMessages: false, addDir: false };
}

/** Resolve a binary to an absolute path: a path with a separator is checked directly, else PATH-scanned. */
async function resolveBinary(binary: string): Promise<string | null> {
  if (binary.includes('/') || binary.includes('\\')) {
    try {
      await access(binary, constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, [binary], { timeout: PROBE_TIMEOUT_MS });
    const first = stdout.trim().split('\n')[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * Detect a coding-agent CLI: resolve its binary on PATH, read its version, and probe `--help` for
 * optional-flag support (capability negotiation, à la nexu-io/open-design + vibecad). Cached per
 * binary for the process. A missing binary returns `{ found: false }` rather than throwing, so the
 * orchestrator can fail dispatch fast with a clear error instead of an opaque exit-127.
 */
export async function detectAgent(opts: DetectOptions): Promise<DetectionResult> {
  const cached = cache.get(opts.binary);
  if (cached) return cached;

  const path = await resolveBinary(opts.binary);
  if (!path) {
    const miss: DetectionResult = { found: false, capabilities: emptyCaps() };
    cache.set(opts.binary, miss);
    return miss;
  }

  let version: string | undefined;
  if (opts.versionArgs) {
    try {
      const { stdout } = await execFileAsync(opts.binary, opts.versionArgs, {
        timeout: PROBE_TIMEOUT_MS,
      });
      version = stdout.trim().split('\n')[0]?.trim();
    } catch {
      /* version probe is best-effort */
    }
  }

  const capabilities = emptyCaps();
  if (opts.helpArgs && opts.capabilityFlags) {
    try {
      const { stdout } = await execFileAsync(opts.binary, opts.helpArgs, {
        timeout: PROBE_TIMEOUT_MS,
      });
      for (const [flag, cap] of Object.entries(opts.capabilityFlags)) {
        if (stdout.includes(flag)) capabilities[cap] = true;
      }
    } catch {
      /* help probe best-effort: leave capabilities optimistic-off */
    }
  }

  const result: DetectionResult = {
    found: true,
    path,
    capabilities,
    ...(version !== undefined ? { version } : {}),
  };
  cache.set(opts.binary, result);
  return result;
}

/** Capabilities probed for a binary, or undefined if `detectAgent` has not run for it yet. */
export function detectedCapabilities(binary: string): AgentCapabilities | undefined {
  return cache.get(binary)?.capabilities;
}

/** Clear the detection cache (tests / config reload). */
export function clearDetectionCache(): void {
  cache.clear();
}
