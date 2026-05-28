import { z } from 'zod';

/** Default Linear workflow states for the Symphony custom flow (decision: custom states). */
export const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress', 'Rework', 'Merging'];
export const DEFAULT_TERMINAL_STATES = ['Done', 'Closed', 'Canceled', 'Cancelled', 'Duplicate'];

export const trackerSchema = z
  .object({
    kind: z.string(),
    endpoint: z.string().default('https://api.linear.app/graphql'),
    api_key: z.string().optional(),
    project_slug: z.string().optional(),
    assignee: z.string().optional(),
    active_states: z.array(z.string()).default(DEFAULT_ACTIVE_STATES),
    terminal_states: z.array(z.string()).default(DEFAULT_TERMINAL_STATES),
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

export const agentSchema = z
  .object({
    backend: z.enum(agentBackendKinds).default('claude-sdk'),
    model: z.string().optional(),
    max_budget_usd: z.number().positive().optional(),
    permission_mode: z.enum(permissionModes).default('bypassPermissions'),
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    max_turns: z.number().int().positive().default(20),
    max_concurrent_agents: z.number().int().positive().default(10),
    max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).default({}),
    max_retry_backoff_ms: z.number().int().positive().default(300_000),
    turn_timeout_ms: z.number().int().positive().default(3_600_000),
    /** 0 disables stall detection. */
    stall_timeout_ms: z.number().int().nonnegative().default(300_000),
    /** CLI backends: override the binary/base command. */
    command: z.string().optional(),
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
export type AgentConfig = z.infer<typeof agentSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
