# Symphony-TS — Path to First Live Run (TODO)

Plan: `~/.claude/plans/act-as-senior-ai-smooth-umbrella.md`

## Phase 0 — Baseline & checkpoint

- [x] Gates green on current tree (build/test/typecheck/lint/format all pass; 96 tests +1 skipped)
- [x] No breakage in uncommitted tree
- [ ] Commit uncommitted work as clean checkpoint on `master`
- [x] Create TODO.md

## Phase 1 — Wire for local-commits-only run

- [ ] Rewrite WORKFLOW.md.example prompt: commit-only, move ticket via `mcp__symphony__linear_graphql`, no push/PR
- [ ] Create real WORKFLOW.md with first-run-safe knobs (low max_turns/continuations, max_budget_usd, raised stall_timeout_ms)
- [ ] Confirm active/terminal state names match Linear exactly

## Phase 2 — First live run + runbook

- [ ] Prereqs: test Linear project, LINEAR_API_KEY, host claude login, throwaway local repo
- [ ] Seed scoped ticket
- [ ] Run orchestrator + dashboard; observe loop
- [ ] Fix what breaks (one change at a time)
- [ ] Write docs/RUNBOOK.md

## Phase 3 — Scoped v1 features

- [ ] stdio MCP server for CLI backends (reuse makeLinearGraphqlExecutor)
- [ ] buildMcpConfig → stdioServers for non-claude-sdk; engine passes --mcp-config
- [ ] Live-loop integration test (Orchestrator + MemoryTracker + FakeWorkspaceManager + runWorker)

## Phase 4 — Verify

- [ ] Re-run gates
- [ ] Second-ticket reproducibility
- [ ] claude-cli backend moves ticket via stdio MCP
- [ ] Dashboard screenshot

## Open questions

1. Repo hosting: standalone GitHub repo vs submodule vs merge? (recommend standalone)
2. Which test Linear project + local repo?
3. Confirm "Human Review" = non-active park = "done for now" in commit-only mode
4. When is push/PR + gh auth wanted? (deferred)
