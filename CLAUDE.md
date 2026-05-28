# CLAUDE.md — symphony-ts

Guidance for working in this TypeScript reimplementation of Symphony. See `../SPEC.md` for the
authoritative behavioral contract and `../CLAUDE.md` for the repo overview.

## What this is

An agent-agnostic orchestrator: polls Linear, gives each ticket an isolated **git worktree**, and
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
  parses, `parsers/` normalize each agent's JSONL).
- `packages/tracker` — `Tracker` interface, `LinearTracker` (read-mostly + `createIssue`), `MemoryTracker`
  (tests/demos), and the shared `linear_graphql` tool executor.
- `packages/core/src/workspace` — git worktrees off one shared clone, hooks, path-safety invariants.
- `packages/core/src/config` + `workflow` — zod schema, `$VAR`/`~` resolution, WorkflowStore hot-reload
  (1s stat-poll, last-known-good on bad reload).
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
- Tracker is read-only from the orchestrator — the agent moves tickets via `linear_graphql`.
- Token accounting uses absolute totals only (delta = max(0, next − lastReported)).
- Workspaces/branches are preserved after success; cleaned only when the issue goes terminal.
