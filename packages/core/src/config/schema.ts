import { z } from 'zod';

/** Default workflow states for the Symphony custom flow (decision: custom states). */
export const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress', 'Rework', 'Merging'];
export const DEFAULT_TERMINAL_STATES = ['Done', 'Closed', 'Canceled', 'Cancelled', 'Duplicate'];

export const trackerSchema = z
  .object({
    kind: z.string(),
    /** Tracker base URL. Required for `plane` (the local instance URL); no default. */
    endpoint: z.string().optional(),
    api_key: z.string().optional(),
    /** Plane: workspace slug (from the workspace URL). */
    workspace_slug: z.string().optional(),
    /** Plane: project UUID (from project settings). */
    project_id: z.string().optional(),
    assignee: z.string().optional(),
    active_states: z.array(z.string()).default(DEFAULT_ACTIVE_STATES),
    terminal_states: z.array(z.string()).default(DEFAULT_TERMINAL_STATES),
  })
  .strict();

/**
 * A registered project the dashboard can switch between. A project = a Plane `project_id` plus its
 * own git repo folder (and optionally a per-project workspace slug). The *active* project is the one
 * whose `project_id`/`repo` currently sit in `tracker`/`workspace`; this list is the registry the
 * dashboard's project switcher reads + appends to (via "+ New project").
 */
export const projectEntrySchema = z
  .object({
    name: z.string(),
    project_id: z.string(),
    repo: z.string(),
    workspace_slug: z.string().optional(),
    /** Plane short identifier (e.g. "SYM"); informational for the switcher. */
    identifier: z.string().optional(),
  })
  .strict();

export const pollingSchema = z
  .object({
    interval_ms: z.number().int().positive().default(30_000),
  })
  .strict();

export const workspaceSchema = z
  .object({
    /** Resolved to <os.tmpdir()>/symphony_workspaces when omitted (see resolve.ts). */
    root: z.string().optional(),
    /** Single shared repo (local path or git URL) every ticket worktrees off. */
    repo: z.string().optional(),
    branch_prefix: z.string().default('symphony/'),
  })
  .strict();

export const hooksSchema = z
  .object({
    after_create: z.string().optional(),
    before_run: z.string().optional(),
    after_run: z.string().optional(),
    before_remove: z.string().optional(),
    timeout_ms: z.number().int().positive().default(60_000),
  })
  .strict();

export const agentBackendKinds = ['claude-sdk', 'claude-cli', 'codex-cli', 'opencode-cli'] as const;
export const permissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
/** Claude settings layers the agent may inherit. `user` = host-global ~/.claude (non-hermetic). */
export const settingSourceKinds = ['user', 'project', 'local'] as const;

export const agentSchema = z
  .object({
    backend: z.enum(agentBackendKinds).default('claude-sdk'),
    model: z.string().optional(),
    max_budget_usd: z.number().positive().optional(),
    permission_mode: z.enum(permissionModes).default('bypassPermissions'),
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    max_turns: z.number().int().positive().default(20),
    /** Cap on consecutive continuation re-dispatches before an issue is blocked. 0 disables. */
    max_continuations: z.number().int().nonnegative().default(50),
    max_concurrent_agents: z.number().int().positive().default(10),
    max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).default({}),
    max_retry_backoff_ms: z.number().int().positive().default(300_000),
    /** Max consecutive failure retries before an issue is blocked for operator input. 0 = unlimited. */
    max_failure_retries: z.number().int().nonnegative().default(5),
    turn_timeout_ms: z.number().int().positive().default(3_600_000),
    /** 0 disables stall detection. */
    stall_timeout_ms: z.number().int().nonnegative().default(300_000),
    /**
     * Backend idle watchdog: kill a turn that emits no events for this long (hung tool / upstream
     * stall) — faster + cleaner than the hard `turn_timeout_ms`. The timer resets on EVERY event
     * (incl. tool activity), so long-but-active runs don't trip it. 0 disables.
     */
    idle_timeout_ms: z.number().int().nonnegative().default(300_000),
    /** CLI backends: override the binary/base command. */
    command: z.string().optional(),
    /** CLI backends: supervise the agent under a tmux session (attach + raw log file). */
    tmux: z.boolean().default(false),
    /**
     * Which Claude settings layers the agent inherits (SDK `settingSources`). Default drops the
     * host-global `user` layer so per-issue runs are reproducible; keeps the worktree's own
     * `project`/`local` `.claude` config. Set `['user','project','local']` to inherit everything.
     */
    setting_sources: z.array(z.enum(settingSourceKinds)).default(['project', 'local']),
    /** CLI backends: pass `--strict-mcp-config` so only Symphony's `--mcp-config` servers load
     * (ignores the host's global/project MCP servers, which can stall a turn). */
    strict_mcp_config: z.boolean().default(true),
    /** Persist a durable per-run `events.jsonl` under `logs_root` for every backend (post-mortem). */
    persist_run_log: z.boolean().default(true),
    /** Stream partial-message deltas (live text) where the agent supports it; off = full messages. */
    stream_partial_messages: z.boolean().default(false),
    /** Optional env var name holding the agent API key (parse-only in v1; host login used). */
    api_key_env: z.string().optional(),
  })
  .strict();

export const serverSchema = z
  .object({
    port: z.number().int().nonnegative().optional(),
    host: z.string().default('127.0.0.1'),
  })
  .strict();

/** Legacy Codex block — parsed (back-compat) but timeouts also read from `agent.*`. */
export const codexSchema = z.looseObject({
  command: z.string().optional(),
  turn_timeout_ms: z.number().int().positive().optional(),
  read_timeout_ms: z.number().int().positive().optional(),
  stall_timeout_ms: z.number().int().nonnegative().optional(),
});

/** Remote workers — parse-only in v1 (SSH deferred). */
export const workerSchema = z
  .object({
    ssh_hosts: z.array(z.string()).default([]),
    max_concurrent_agents_per_host: z.number().int().positive().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    tracker: trackerSchema,
    /** Registry of switchable projects (dashboard project switcher). */
    projects: z.array(projectEntrySchema).default([]),
    /** Root dir for raw tmux session logs. Resolved to <tmpdir>/symphony_logs when omitted. */
    logs_root: z.string().optional(),
    polling: pollingSchema.prefault({}),
    workspace: workspaceSchema.prefault({}),
    hooks: hooksSchema.prefault({}),
    agent: agentSchema.prefault({}),
    server: serverSchema.optional(),
    worker: workerSchema.optional(),
    codex: codexSchema.optional(),
  })
  .strict();

/** Parsed (pre-resolution) config — `$VAR`/`~` still literal. */
export type ParsedConfig = z.infer<typeof configSchema>;
export type TrackerConfig = z.infer<typeof trackerSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
