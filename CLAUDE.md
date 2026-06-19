# CLAUDE.md — symphony-ts

Guidance for working in this TypeScript reimplementation of Symphony. See `../SPEC.md` for the
authoritative behavioral contract and `../CLAUDE.md` for the repo overview.

## What this is

An agent-agnostic orchestrator: polls a **local file-based task store** (`~/.symphony`, plain JSON —
no Docker, no database, no external services, no auth), gives each ticket an isolated **git
worktree**, and runs a **local coding agent** (Claude Code by default) until the ticket reaches a
terminal state. A single-user local app for delegating tasks to coding agents. v1 ships two backends
behind one `CodingAgentBackend` interface — Claude Agent SDK and a CLI stream-json family
(claude/codex/opencode).

## Commands (run from this directory)

- `pnpm install` — deps (Node ≥ 22, pnpm@10)
- `pnpm build` — tsup, all packages (build deps before typechecking a dependent package; the
  dashboard build is `tsup && vite build`, so its Preact client is bundled by `pnpm build` too)
- `pnpm test` — vitest, all packages
- Gates (CI runs them in this order): `pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`.
  `pnpm format` writes; `pnpm format:check` is the gate.
- Single test file: `pnpm --filter @symphony/core exec vitest run src/orchestrator/orchestrator.test.ts`
- Run it: `node apps/cli/dist/main.js ./WORKFLOW.md --port 4500` (after build), or `symphony ticket create "<title>" [--desc --state --priority]`. No services to start — state lives in `~/.symphony`.
- `pnpm dev` — watch mode. Two URLs: **:4500** = orchestrator API + the built Preact SPA (production-style, no client HMR); **:5173** = Vite HMR dev server for frontend work (proxies `/api`, incl. SSE, to :4500). Open :5173 while editing `apps/dashboard/client`. (The dashboard's `dev` is `tsup --watch` with `clean:false` so it doesn't wipe the vite-built `dist/client`; `build` does an explicit `pnpm clean` first.)

## Architecture (the load-bearing parts)

- `packages/core/src/orchestrator/orchestrator.ts` — the heart. A long-lived class with a **serial
  mutation queue (concurrency 1)** that replaces Elixir's GenServer mailbox: every state write goes
  through `enqueue()`. Holds running/claimed/blocked/retry maps + token totals. Owns poll tick,
  dispatch, retry/backoff, reconcile (stall + tracker-state + blocked), startup cleanup, snapshot.
- `orchestrator/worker.ts` — runs one issue: worktree → before_run → turn loop (≤ max_turns,
  continuation on same session) → after_run. Returns completed/blocked/failed/aborted.
- `packages/agent-backends` — the agent-agnostic seam. `backend.ts` defines `CodingAgentBackend` +
  the normalized `AgentEvent` vocabulary. `claude-sdk/` wraps the SDK; `cli-stream-json/` is the
  declarative-adapter + one-engine pattern (`agent-defs.ts` = config per agent, `engine.ts` spawns +
  parses, `parsers/` normalize each agent's JSONL). With `agent.tmux`, `engine.ts` instead runs the
  CLI agent under a tmux session (`tmux.ts` = injectable `TmuxController`), `tee`s raw stdout to a
  `run.jsonl` log it tails, and emits a `process_started` event (pid + session name). tmux ownership
  lives entirely here — the orchestrator only records the session name and aborts (abort → kill).
- `packages/tracker` — `Tracker` interface, `FileTracker` (the default; per-issue JSON store under
  `<data_root>/projects/<projectKey>/`, in `file/{store,adapter}.ts`), `MemoryTracker` (tests), and
  the agent-facing semantic tracker tools `tracker_get_task`/`tracker_update_status`/
  `tracker_add_comment` (`tools/file-semantic.ts`, shared by the SDK MCP server + the stdio bridge
  client). `file/store.ts` does atomic temp+rename writes and a **process-wide per-file async mutex**
  (keyed by absolute path) so the orchestrator's tracker and the SDK MCP executors' tracker serialize.
  `meta.json` is the single source of truth for issue ids (`<IDENTIFIER>-<seq>`).
- `packages/core/src/workspace` — git worktrees off one shared clone, hooks, path-safety invariants.
- `packages/core/src/config` + `workflow` — zod schema, `$VAR`/`~` resolution, WorkflowStore hot-reload
  (1s stat-poll, last-known-good on bad reload).
- `packages/core/src/prompt` — `system-prompt.ts` (the Claude-optimized operating contract appended to
  the `claude_code` preset on every turn; override via `agent.system_prompt`) + `builder.ts` (renders
  the per-issue `WORKFLOW.md` body via Liquid, plus continuation guidance). `agent.effort`/
  `agent.thinking` tune reasoning depth.
- `apps/dashboard` — fastify JSON API (`src/server.ts`) + a **Preact + Vite SPA** (`client/`: kanban
  `board`, `projects` switcher, `settings`, `agents`, `modals`) served from `dist`. Routes are read
  endpoints (`/api/v1/state|meta|capabilities|projects|settings|board|states|labels|sessions`) plus a
  few writes (`POST /api/v1/tickets`, `sessions/terminate-all`, `refresh`). The board can **live-switch
  the active project**: the CLI passes `trackerFactory`/`mcpConfigFactory`/`workspaceManagerFactory` to
  the orchestrator so `Orchestrator.switchProject(config)` atomically rebuilds tracker/MCP/workspace
  without a restart.
- `packages/core/src/tracker-bridge.ts` — a loopback **Unix-socket bridge** the CLI starts for the
  file tracker. Out-of-process CLI agents (claude-cli/codex/opencode) drive the tracker through it so
  the orchestrator process stays the **single writer** of the file store (no cross-process locking).
  The in-process SDK backend skips the bridge and calls the executors directly.
- `packages/core/src/observability` — `createLogger` (pino; pretty by default, `--json-logs` for JSON).

## Conventions

- TS strict (`exactOptionalPropertyTypes` — never assign `undefined` to optional props; spread them
  conditionally: `...(x !== undefined ? { x } : {})`). Also `noUncheckedIndexedAccess` (array/record
  index access is `T | undefined` — guard or `!` it) and `verbatimModuleSyntax` (use `import type`).
  ESM `NodeNext` — relative imports end in `.js`.
- Internal imports use package names (`@symphony/core`). No `tsc -b`/project references — each package
  builds independently with tsup (emits its own d.ts). After editing a package others depend on,
  rebuild it before typechecking the dependents.
- Keep the orchestrator **agent-neutral**: anything agent-specific lives only in `agent-backends`.
- zod v4: use `.prefault({})` (not `.default({})`) for nested-object defaults.
- Tests use `MemoryTracker` + `MockBackend`/`GatedBackend` + `FakeWorkspaceManager` (in `core/src/test-support.ts`)
  with `vi.useFakeTimers()`. Real git-worktree + CLI-engine paths have dedicated subprocess tests.

## Invariants (do not break)

- **Workspace mode** (`workspace.mode`, default `single_dir`): `single_dir` runs the agent directly in
  `workspace.repo` (a local path) on its current branch, ONE task at a time (the orchestrator clamps
  `availableSlots` to 1), so tasks build on each other; `cleanup`/`integrate` are no-ops and there are no
  worktrees. `worktree` keeps the shared-clone + per-issue-worktree model. The factory
  (`runtime.buildWorkspaceManager`) picks the manager; `SingleDirWorkspaceManager` vs `WorkspaceManager`
  both implement `IWorkspaceManager` (+ `integrate`).
- Agent cwd must equal the workspace path; in `worktree` mode it must stay under `workspace.root`
  (path-safety). In `single_dir` mode the workspace IS the repo toplevel (intended; `assertUnderRoot`
  is not applied there).
- The orchestrator is **mostly** read-only on the tracker — the agent moves tickets via the semantic
  tracker tools and may only set active + `review_state`, never a terminal state. The orchestrator
  itself writes the tracker in three narrow spots: `markInProgressOnPickup` (entry-lane → In Progress on
  dispatch, awaited), `finalizeTerminal` (worktree-mode merge-on-accept comment), and
  `migrateDroppedStates` (one-time Rework/Merging → In Progress). CLI-backend writes funnel through the
  orchestrator's bridge.
- The file store keeps state id === state name; `blockedBy` is always `[]` (auto-skip disabled). The
  orchestrator's active/terminal classification comes from `config.tracker.{active,terminal}_states`
  (state **names**); `states.json` is display-only (lane order + type/color) and tolerates drift (an
  issue in a state missing from it still gets a board lane).
- Token accounting uses absolute totals only (delta = max(0, next − lastReported)).
- Worktree-mode workspaces/branches are preserved after success; on a terminal transition the
  orchestrator runs `finalizeTerminal` — for a **completed** terminal (Done/Closed) it merges the issue
  branch into `base_branch` (when `merge_on_accept`) so the next worktree builds on top, then cleans up;
  a **cancel** terminal (Cancelled/Duplicate) cleans up without merging; a merge **conflict** preserves
  the branch and surfaces a `merge_failures` banner. The Accept path for a parked-review ticket triggers
  this via `Orchestrator.onExternalMove` (the reconcile loops only see tracked issues). `single_dir`
  cleanup is a no-op (never delete the project dir).
- Continuation re-dispatch is bounded by `agent.max_continuations` (default 50, `0` = unlimited):
  after that many consecutive continuations without reaching a terminal state, the issue is moved to
  `blocked` for operator input instead of looping (prevents runaway token spend).
- `switchProject` is the **only** path that re-points tracker/repo scope. It swaps the orchestrator's
  mutable tracker/config atomically and clears `resumeSessions` (sessions don't carry across projects).

## Docs & references

- `../SPEC.md` — authoritative behavioral contract; `WORKFLOW.md.example` — annotated config contract.
- `docs/RUNBOOK.md` — operate/troubleshoot a live run; `docs/VALIDATION_PLAN.md` — manual validation.

## Failure-recovery layer (the load-bearing recent additions)

- **Failure classification** lives in `agent-backends/src/failure-classification.ts` (`classify()`):
  one cascade — structured category > OS signal/exit > error-text — mapping every failure onto an
  `ErrorCategory` + a derived `retryable` bit. Both backends call it; never re-derive categories ad-hoc.
- **Retry is category-aware and capped** (`orchestrator.failOrBlock`): a non-retryable failure
  (`agent_not_found`, `invalid_workspace_cwd`, `auth_required`, `prompt_too_large`, process crash) →
  `blocked` immediately; a retryable one → jittered backoff (`dispatch.retryDelay`, equal-jitter) up to
  `agent.max_failure_retries` (default 5; `0` = unlimited), then `blocked`. Never retry a hard budget stop.
- **Idle watchdog** (`agent.idle_timeout_ms`, default 300s, `0` disables) lives **inside** the backends
  (`engine.ts` + `claude-sdk-backend.ts`): resets on every event, kills a silent turn → `idle_timeout`
  (retryable), distinct from the hard `turn_timeout_ms` and the coarse orchestrator `stall_timeout_ms`.
- **Resume-on-failure** (`state.resumeSessions`): a retryable failure (or a continuation) carries the
  agent's `sessionId` to the next dispatch **only if a side-effect occurred** (a `tool_use`/`tool_result`
  was seen) — else cold restart. Cleared on terminal/blocked/nonactive/fresh-poll dispatch (no leak).
- **Detection** runs once at `Orchestrator.start()` (`agent-backends` `detectAgent`): PATH + version +
  `--help` capability probe (cached). A missing binary fails `dispatchPreflight` (skip-with-reason, not
  an opaque exit-127). Capability flags gate optional CLI args (e.g. `--include-partial-messages`).
- **Hermeticity is configurable** (`agent.setting_sources` default `['project','local']`,
  `agent.strict_mcp_config` default true): the SDK drops host-global `user` settings by default and the
  CLI passes `--strict-mcp-config`, so per-issue runs are reproducible and don't inherit MCP servers that
  can stall a turn. The tracker tools are always passed explicitly, so this is safe.
- **Durable audit log** (`agent.persist_run_log`, default true): the worker appends every `AgentEvent`
  to `logs_root/<identifier>/<turn>/events.jsonl` (secrets redacted) for all backends — tests set it
  `false` to avoid file I/O. The CLI engine also folds non-JSON stdout lines into failure diagnostics
  instead of dropping them, and enforces `max_budget_usd` (parity with the SDK).
