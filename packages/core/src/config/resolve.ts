import os from 'node:os';
import path from 'node:path';
import { configSchema, type ParsedConfig } from './schema.js';

/** Resolved config: workspace.root is guaranteed absolute; `$VAR`/`~` expanded. */
export type SymphonyConfig = ParsedConfig & {
  workspace: ParsedConfig['workspace'] & { root: string };
};

const VAR_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/** Resolve a value of the form `$NAME` from the environment; otherwise return as-is. */
function resolveVar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = VAR_RE.exec(value);
  if (!m) return value;
  const env = process.env[m[1]!];
  return env && env.length > 0 ? env : undefined;
}

function isRemoteRepo(repo: string): boolean {
  return /:\/\//.test(repo) || /^[^/]+@[^/]+:/.test(repo); // scheme:// or git@host:path
}

function expandPath(value: string, baseDir: string): string {
  let p = value;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(baseDir, p);
}

/**
 * Pre-parse normalization: lets legacy Elixir WORKFLOW.md files (which use a
 * `codex:` block and no `agent:` block) keep working by mapping codex timeouts
 * onto the agent block. Mutates a shallow copy of the raw YAML object.
 */
export function normalizeRawConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const codex = obj['codex'];
  if (obj['agent'] === undefined && typeof codex === 'object' && codex !== null) {
    const c = codex as Record<string, unknown>;
    const agent: Record<string, unknown> = { backend: 'codex-cli' };
    if (typeof c['turn_timeout_ms'] === 'number') agent['turn_timeout_ms'] = c['turn_timeout_ms'];
    if (typeof c['stall_timeout_ms'] === 'number')
      agent['stall_timeout_ms'] = c['stall_timeout_ms'];
    obj['agent'] = agent;
  }
  return obj;
}

/** Parse a raw YAML object into a validated config (throws ZodError on failure). */
export function parseConfig(raw: unknown): ParsedConfig {
  return configSchema.parse(normalizeRawConfig(raw));
}

/**
 * Resolve `$VAR` indirection and path expansion. `workflowDir` is the directory
 * of WORKFLOW.md (relative paths resolve against it).
 */
export function resolveConfig(parsed: ParsedConfig, workflowDir: string): SymphonyConfig {
  const tracker = { ...parsed.tracker };

  // api_key: explicit $VAR, else fall back to LINEAR_API_KEY.
  const apiKey = resolveVar(tracker.api_key) ?? process.env['LINEAR_API_KEY'];
  if (apiKey !== undefined) tracker.api_key = apiKey;
  else delete tracker.api_key;

  const assignee = resolveVar(tracker.assignee);
  if (assignee !== undefined) tracker.assignee = assignee;
  else if (tracker.assignee !== undefined) delete tracker.assignee;

  const workspace = { ...parsed.workspace };
  const rawRoot = resolveVar(workspace.root);
  const rootBase = rawRoot ?? path.join(os.tmpdir(), 'symphony_workspaces');
  const root = expandPath(rootBase, workflowDir);

  const rawRepo = resolveVar(workspace.repo);
  let repo: string | undefined;
  if (rawRepo !== undefined)
    repo = isRemoteRepo(rawRepo) ? rawRepo : expandPath(rawRepo, workflowDir);

  const resolvedWorkspace = { ...workspace, root, ...(repo !== undefined ? { repo } : {}) };
  if (repo === undefined) delete resolvedWorkspace.repo;

  return { ...parsed, tracker, workspace: resolvedWorkspace };
}
