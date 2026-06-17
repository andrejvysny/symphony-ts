# CLAUDE.md — symphony-ts

Guidance for working in this TypeScript reimplementation of Symphony. See `../SPEC.md` for the
authoritative behavioral contract and `../CLAUDE.md` for the repo overview.

## What this is

An agent-agnostic orchestrator: polls a **local self-hosted Plane** instance, gives each ticket an isolated **git worktree**, and
runs a **local coding agent** (Claude Code by default) until the ticket reaches a terminal state.
v1 ships two backends behind one `CodingAgentBackend` interface — Claude Agent SDK and a CLI
stream-json family (claude/codex/opencode).

## Commands (run from this directory)

- `pnpm install` — deps (Node ≥ 22, pnpm)
- `pnpm build` — tsup, all packages (build deps before typechecking a dependent package)
- `pnpm test` — vitest, all packages
- `pnpm typecheck` / `pnpm lint` / `pnpm format` — gates
- Single test file: `pnpm --filter @symphony/core exec vitest run src/orchestrator/orchestrator.test.ts`
- Run it: `node apps/cli/dist/main.js ./WORKFLOW.md --port 4500` (after build), or `symphony ticket create "<title>"`

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
- `packages/tracker` — `Tracker` interface, `PlaneTracker` (REST adapter over a local self-hosted
  Plane; read-mostly + `createIssue`), `MemoryTracker` (tests), `PlaneClient` (retry/backoff REST
  transport in `http/transport.ts`), and the agent-facing tracker tools: the semantic
  `tracker_get_task`/`tracker_update_status`/`tracker_add_comment` executors (`tools/plane-semantic.ts`,
  shared by the SDK + stdio MCP servers) plus an opt-in raw `tracker_api` passthrough
  (`tools/plane-rest.ts`, **path-confined**). Plane runs locally via `infra/plane/` (`pnpm plane:up`).
- `packages/core/src/workspace` — git worktrees off one shared clone, hooks, path-safety invariants.
- `packages/core/src/config` + `workflow` — zod schema, `$VAR`/`~` resolution, WorkflowStore hot-reload
  (1s stat-poll, last-known-good on bad reload).
- `packages/core/src/prompt` — `system-prompt.ts` (the Claude-optimized operating contract appended to
  the `claude_code` preset on every turn; override via `agent.system_prompt`) + `builder.ts` (renders
  the per-issue `WORKFLOW.md` body via Liquid, plus continuation guidance). `agent.effort`/
  `agent.thinking` tune reasoning depth.
- `apps/dashboard` — fastify JSON API (`/api/v1/state|:id|refresh`) + the HTML board view.

## Conventions

- TS strict (`exactOptionalPropertyTypes` — never assign `undefined` to optional props; spread them
  conditionally: `...(x !== undefined ? { x } : {})`). ESM `NodeNext` — relative imports end in `.js`.
- Internal imports use package names (`@symphony/core`). No `tsc -b`/project references — each package
  builds independently with tsup (emits its own d.ts). After editing a package others depend on,
  rebuild it before typechecking the dependents.
- Keep the orchestrator **agent-neutral**: anything agent-specific lives only in `agent-backends`.
- zod v4: use `.prefault({})` (not `.default({})`) for nested-object defaults.
- Tests use `MemoryTracker` + `MockBackend`/`GatedBackend` + `FakeWorkspaceManager` (in `core/src/test-support.ts`)
  with `vi.useFakeTimers()`. Real git-worktree + CLI-engine paths have dedicated subprocess tests.

## Invariants (do not break)

- Agent cwd must equal the worktree path; worktree must stay under `workspace.root` (path-safety).
- Tracker is read-only from the orchestrator — the agent moves tickets via the semantic tracker tools
  (`tracker_get_task`/`tracker_update_status`/`tracker_add_comment`); the raw `tracker_api` passthrough
  is opt-in (`agent.allow_raw_tracker_api`). The agent may only set active + `review_state`, not terminal.
- Plane has no public issue-relations endpoint, so `blockedBy` is always `[]` (auto-skip disabled); the
  orchestrator compares state **names** while Plane mutates by state **UUID** (the adapter joins them).
- Token accounting uses absolute totals only (delta = max(0, next − lastReported)).
- Workspaces/branches are preserved after success; cleaned only when the issue goes terminal. A
  turn that ends with the issue already terminal is cleaned up immediately (no continuation).
- Continuation re-dispatch is bounded by `agent.max_continuations` (default 50, `0` = unlimited):
  after that many consecutive continuations without reaching a terminal state, the issue is moved to
  `blocked` for operator input instead of looping (prevents runaway token spend).

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
