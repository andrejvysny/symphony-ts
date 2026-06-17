# Symphony-TS — Path to First Live Run (TODO)

Plan: `~/.claude/plans/act-as-senior-ai-smooth-umbrella.md`

## Phase 0 — Baseline & checkpoint

- [x] Gates green on current tree (build/test/typecheck/lint/format all pass)
- [x] No breakage in uncommitted tree
- [x] Commit uncommitted work as clean checkpoint on `master` (commit d6f3ddf)
- [x] Create TODO.md

## Phase 1 — Wire for local-commits-only run

- [x] Rewrite WORKFLOW.md.example prompt: commit-only, move ticket via `mcp__symphony__linear_graphql`, no push/PR
- [x] Create real WORKFLOW.md with first-run-safe knobs (gitignored; max_turns 6, max_continuations 2, max_budget_usd 2, stall 15m)
- [ ] **(needs you)** Confirm active/terminal state names match your Linear board exactly

## Phase 2 — First live run + runbook

- [x] Write docs/RUNBOOK.md (full first-run guide + gotchas)
- [ ] **(needs you)** Prereqs: Linear project slug, LINEAR_API_KEY, host claude login, throwaway local repo
- [ ] **(needs you)** Set the two REPLACE_ME values in WORKFLOW.md
- [ ] **(needs you)** Seed scoped ticket
- [ ] **(needs you)** Run orchestrator + dashboard; observe loop
- [ ] Fix what breaks (one change at a time) — I do this once you run it / share output

## Phase 3 — Scoped v1 features

- [x] stdio MCP server for CLI backends (packages/tracker/src/tools/stdio-linear-server.ts, reuses makeLinearGraphqlExecutor)
- [x] buildMcpConfig → stdioServers for CLI backends; claude-cli engine already passes --mcp-config (codex/opencode flag wiring still deferred)
- [x] stdio MCP test (in-process InMemoryTransport, passing)
- [x] Live-loop integration test — orchestrator + REAL git worktree + real commit + park → preserved (passing)

## Phase 4 — Verify

- [x] Re-run gates — build/test (100 pass +1 skip)/typecheck/lint/format all green
- [ ] **(needs live run)** Second-ticket reproducibility
- [ ] **(needs live run)** claude-cli backend moves ticket via stdio MCP
- [ ] **(needs live run)** Dashboard screenshot

## Phase 5 — Hardening for parallel local Claude Code + offline validation (done)

- [x] **A.0 concurrency blocker**: `McpConfig.sdkServers` is now a per-run factory — each
      claude-sdk run builds a fresh in-process MCP server. Sharing one instance silently dropped
      the tool for the 2nd+ concurrent agent (it could not park its ticket). CI test added.
- [x] **A.1 memory MCP tool** (`tracker/tools/memory-tools.ts` + `agent-backends/mcp/sdk-memory-tool.ts`):
      offline `set_issue_state`/`add_comment` so a real agent parks its MemoryTracker ticket.
- [x] **A.2/A.3 offline dry-run** (`scripts/dry-run-claude.mjs`): 3 REAL Claude Code agents, parallel,
      no Linear. PASS — all 3 implemented + committed on `symphony/<ID>` + parked via MCP; worktrees
      preserved; tokens accounted. One ticket hit a transient API 529 and **auto-recovered via retry**
      (validated the failure→retry path with a real agent).
- [x] **B.1 SDK turn timeout**: `claude-sdk` now honors `turn_timeout_ms` (aborts → `turn_timeout`).
- [x] **B.2 tests**: SDK backend (timeout, abort, per-run MCP, blocked, agent_not_found) + N=3
      orchestrator concurrency (no cross-issue event/token wiring). 113 tests green.
- [x] **B.4 operator unblock**: `orchestrator.unblock(id)` + `POST /api/v1/sessions/:id/unblock` —
      recover a blocked-but-active issue without bouncing its tracker state.
- [x] **B.5 error polish**: SDK failures categorized (`agent_not_found` vs `response_error`).
- [x] **C.0 live state-id recipe**: WORKFLOW prompt (+ example + RUNBOOK) now tells the agent to
      resolve the "Human Review" workflow-state UUID before `issueUpdate{stateId}` (memory dry-run
      can't surface this; `name==id`).
- [ ] **B.3 token-on-resume**: documented as a known approximation (SDK exposes no thread-cumulative
      total across resumed turns); `max_budget_usd` is the authoritative per-run bound. Not fixed.

## Phase C — Linear live run (needs you; commit-only)

- [ ] Set the two `REPLACE_ME` in `WORKFLOW.md`; confirm exact active/terminal/park state names.
- [ ] First ticket → reproducibility → bump `max_concurrent_agents` to 2–4 → `claude-cli`+tmux backend.

## Open questions

1. Repo hosting: standalone GitHub repo vs submodule vs merge? (recommend standalone)
2. Which test Linear project + local repo for the first run?
3. Confirm "Human Review" = non-active park = "done for now" in commit-only mode
4. When is push/PR + gh auth wanted? (deferred)
5. Commit the Phase 1/3 work now, or after the live run? (I left it uncommitted per your no-auto-commit rule)
