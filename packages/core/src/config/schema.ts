import { z } from 'zod';

/**
 * Default workflow states for the Symphony custom flow (decision: custom states).
 * Lanes shown on the board: Backlog · Todo · In Progress · Human Review · Done. "Rework" and
 * "Merging" are intentionally NOT states — rework is `In Progress` + a `rework` label badge, and
 * merging is an orchestrator-side step on accept. Cancelled stays a terminal state for classification
 * but is hidden from the board.
 */
export const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress'];
export const DEFAULT_TERMINAL_STATES = ['Done', 'Closed', 'Canceled', 'Cancelled', 'Duplicate'];

export const trackerSchema = z
  .object({
    /** `file` (local per-issue JSON store, the default) or `memory` (tests). */
    kind: z.string().default('file'),
    /** `file` store root (resolved to ~/.symphony when omitted); per-project data lives under it. */
    data_root: z.string().optional(),
    /** Active project key — a slug naming the project's dir under `data_root`. Unset = no active
     *  project (the dashboard prompts to create/open one); there is no implicit "default" project. */
    project_id: z.string().optional(),
    active_states: z.array(z.string()).default(DEFAULT_ACTIVE_STATES),
    terminal_states: z.array(z.string()).default(DEFAULT_TERMINAL_STATES),
    /** Non-active, non-terminal "park" state the agent moves an issue to for human review. */
    review_state: z.string().default('Human Review'),
    /**
     * Non-active, non-terminal lane (seeded leftmost) for tickets not yet ready to implement.
     * Human-only — the orchestrator never dispatches it. Set to `''` to disable the lane.
     */
    backlog_state: z.string().default('Backlog'),
    /**
     * State an issue is moved to the instant an agent picks it up from the entry lane (the first
     * active state), so the board shows work-in-progress immediately instead of the card lingering
     * in Todo until the agent moves it. Must be an active state. Set to `''` to disable.
     */
    in_progress_state: z.string().default('In Progress'),
  })
  .strict();

/**
 * A registered project the dashboard can switch between. A project = a `project_id` (its dir key
 * under the file store's `data_root`) plus its own git repo folder. The *active* project is the one
 * whose `project_id`/`repo` currently sit in `tracker`/`workspace`; this list is the registry the
 * dashboard's project switcher reads + appends to (via "+ New project").
 */
export const projectEntrySchema = z
  .object({
    name: z.string(),
    project_id: z.string(),
    repo: z.string(),
    /** Issue id prefix (e.g. "SYM" → SYM-1); seeds the project's meta.json on creation. */
    identifier: z.string().optional(),
  })
  .strict();

export const pollingSchema = z
  .object({
    interval_ms: z.number().int().positive().default(30_000),
  })
  .strict();

export const workspaceModes = ['single_dir', 'worktree'] as const;

export const workspaceSchema = z
  .object({
    /**
     * `single_dir` (default): run the agent directly in `repo`, one task at a time, committing on the
     * repo's current branch so tasks build on each other. `worktree`: isolate each ticket in its own
     * git worktree branched off `base_branch`, merged back on accept (see `merge_on_accept`).
     */
    mode: z.enum(workspaceModes).default('single_dir'),
    /** Resolved to <os.tmpdir()>/symphony_workspaces when omitted (see resolve.ts). worktree mode only. */
    root: z.string().optional(),
    /** The project repo. `single_dir`: a LOCAL path the agent edits directly. `worktree`: the repo
     * (local path or git URL) every ticket worktrees off. */
    repo: z.string().optional(),
    branch_prefix: z.string().default('symphony/'),
    /** worktree mode: branch new worktrees off this branch (defaults to the clone's default branch). */
    base_branch: z.string().optional(),
    /** worktree mode: on accept (review→Done), merge the issue branch into `base_branch` so the next
     * worktree builds on top. Disable to keep branches isolated. */
    merge_on_accept: z.boolean().default(true),
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
    /** APPEND text layered on the `claude_code` system-prompt preset; overrides the built-in default. */
    system_prompt: z.string().optional(),
    /** Reasoning effort (SDK `effort`). Omit to use the model default ('high'). */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    /** Thinking mode (SDK `thinking`): `adaptive` (Claude decides depth) or `disabled`. */
    thinking: z.enum(['adaptive', 'disabled']).optional(),
    max_budget_usd: z.number().positive().optional(),
    permission_mode: z.enum(permissionModes).default('bypassPermissions'),
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    /**
     * Symphony's per-task RE-PROMPT budget — NOT the agent's internal step count. How many times the
     * worker (re-)prompts the agent within one dispatch. Default 2 = one full delegation (turn 1) plus
     * at most one finish-up nudge (turn 2) if the agent stops before parking the issue for review. The
     * agent's own agentic loop (planning/todos/tool calls) is uncapped within a turn — see
     * `max_agent_steps`.
     */
    max_turns: z.number().int().positive().default(2),
    /**
     * Cap on consecutive continuation re-dispatches before an issue is blocked for operator input.
     * 0 = unlimited. Default 1 blocks on the first exhaustion (the single nudge lives inside the worker
     * turn loop), so a still-unfinished task surfaces to a human instead of looping.
     */
    max_continuations: z.number().int().nonnegative().default(1),
    /**
     * The agent's OWN internal step budget within a single delegation (maps to the SDK's `maxTurns`):
     * model↔tool cycles, not Symphony re-prompts. Omit (default) to leave it UNCAPPED so one delegation
     * runs the task to completion; set a positive integer only to bound a runaway agent loop.
     */
    max_agent_steps: z.number().int().positive().optional(),
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
    /**
     * Poll the operator's Claude subscription usage limits (5h + weekly) for the dashboard top-bar
     * gauge. On by default for Claude backends: it reads the Claude Code OAuth token (file/Keychain)
     * and hits the UNDOCUMENTED `oauth/usage` endpoint. It only returns data on a Claude Pro/Max login
     * (API-key auth → the gauge shows "n/a") and may prompt for macOS Keychain access on first read.
     * Set `false` to disable the polling entirely (hides the gauge).
     */
    usage_limits: z.boolean().default(true),
    /** Optional env var name holding the agent API key (parse-only in v1; host login used). */
    api_key_env: z.string().optional(),
  })
  .strict();

/**
 * Plan-mode config (the read-only "Plan" run launched from a Backlog ticket). Plan runs always force
 * `permissionMode:'plan'`, default to stronger reasoning than execution, and never move the ticket's
 * state. See SPEC / CLAUDE.md "plan mode".
 */
export const planSchema = z
  .object({
    /**
     * How the planning agent surfaces a clarifying question: `live` keeps the run open and continues
     * in-session the instant the operator answers (best continuity; holds an agent slot while waiting);
     * `pause` parks the ticket as "needs input" and resumes the agent's session on answer (frees the
     * slot). Flip it from the dashboard Settings.
     */
    qa_mode: z.enum(['live', 'pause']).default('live'),
    /** Reasoning effort for plan runs (stronger default than execution). A ticket's `effort` overrides. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    /** Thinking mode for plan runs (SDK `thinking`). */
    thinking: z.enum(['adaptive', 'disabled']).default('adaptive'),
    /** Optional model override for plan runs (falls back to `agent.model`; a ticket's `model` overrides). */
    model: z.string().optional(),
    /** APPEND text layered on the plan system-prompt preset; overrides the built-in plan contract. */
    system_prompt: z.string().optional(),
    /**
     * Backend idle watchdog for plan runs (ms). Auto-disabled while a question is pending (so the open
     * `live`-mode query is not killed while the operator thinks). 0 disables entirely.
     */
    idle_timeout_ms: z.number().int().nonnegative().default(300_000),
  })
  .strict();

/**
 * Sequence-mode config (the read-only "ordering" run launched from the Sequence tab over a SUBSET of
 * Backlog tickets). Mirrors {@link planSchema} — forces `permissionMode:'plan'`, defaults to stronger
 * reasoning — but operates on N tickets and produces a dependency-ordered sequence, not a per-ticket
 * plan. Feature-gated on the claude-sdk backend + a tracker order store.
 */
export const orderSchema = z
  .object({
    /** Master switch for the Sequence feature (hides the tab/endpoints when false). */
    enabled: z.boolean().default(true),
    /** How a sequencing question is surfaced — same semantics as `plan.qa_mode`. */
    qa_mode: z.enum(['live', 'pause']).default('live'),
    /** Reasoning effort for ordering runs. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    /** Thinking mode for ordering runs (SDK `thinking`). */
    thinking: z.enum(['adaptive', 'disabled']).default('adaptive'),
    /** Optional model override for ordering runs (falls back to `agent.model`). */
    model: z.string().optional(),
    /** APPEND text layered on the order system-prompt preset; overrides the built-in contract. */
    system_prompt: z.string().optional(),
    /** Backend idle watchdog for ordering runs (ms); auto-disabled while a question is pending. */
    idle_timeout_ms: z.number().int().nonnegative().default(300_000),
    /** Hard cap on tickets per ordering run (bounds prompt size). */
    max_subset_size: z.number().int().positive().default(20),
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
    tracker: trackerSchema.prefault({}),
    /** Registry of switchable projects (dashboard project switcher). */
    projects: z.array(projectEntrySchema).default([]),
    /** Root dir for raw tmux session logs. Resolved to <tmpdir>/symphony_logs when omitted. */
    logs_root: z.string().optional(),
    polling: pollingSchema.prefault({}),
    workspace: workspaceSchema.prefault({}),
    hooks: hooksSchema.prefault({}),
    agent: agentSchema.prefault({}),
    plan: planSchema.prefault({}),
    order: orderSchema.prefault({}),
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
export type PlanConfig = z.infer<typeof planSchema>;
export type OrderConfig = z.infer<typeof orderSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
