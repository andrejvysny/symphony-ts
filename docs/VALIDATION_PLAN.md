# Symphony-TS — End-to-End Validation Plan & Target Project

> Findings + recommendation for picking the **simplest project that fully validates Symphony-TS**.
> Authored 2026-06-17 from a multi-agent analysis of the codebase. Companion to `docs/RUNBOOK.md`
> (which covers the mechanics of a single first run); this doc covers _what to validate_ and the
> _target repo + ticket set + playbook_ that exercises the whole feature surface.

## 1. What "testing Symphony-TS" actually means

Symphony-TS is an **orchestrator, not an app**. It polls a **local file-based tracker** (a per-issue
JSON store under `~/.symphony`, no database and no external services), gives each ticket an isolated
**git worktree** off one shared clone, and runs a **local Claude Code agent** until the ticket
commits + reaches a terminal/parked state, up to `max_concurrent_agents` at once. The orchestrator
is **read-only** on the tracker; the **agent moves its own ticket** via the semantic tracker tools
(`tracker_get_task` / `tracker_update_status` / `tracker_add_comment`).

Therefore "a project to test it" is **a target repo + a set of tickets** (issue JSON files) that
drive the agents. The validation question is: _which repo + tickets exercise the most real Symphony
behavior, cheaply?_

## 2. The dominant constraint (drives every other decision)

`blockedBy` is always `[]` (`packages/tracker/src/file/adapter.ts:232`,
`packages/tracker/src/memory/memory-tracker.ts:145`) — the file store exposes no issue relations, so
there is **zero automatic dependency ordering**. Anything that runs concurrently must be
**independent and touch disjoint files**, or worktrees silently co-edit the same lines, each branch
parks a _fake_ "success", and the conflict is never resolved (commit-only mode performs no
cross-branch merge).

This single fact rules out most "real app" ideas (tickets stack on each other) and forces a project
of **many small, independent, individually test-verifiable units**.

### Hard requirements for the target repo + ticket set

1. **Independent tickets** — no ticket's correctness depends on another's output.
2. **Disjoint files in parallel** — concurrently-dispatched tickets create/edit different files/dirs.
3. **Self-verifiable** — the agent can run `build`/`test`/`lint` in-worktree so terminal completion is
   _earned_, not hallucinated. Needs a fast, offline toolchain.
4. **Has `package.json`** (or equivalent) — makes the `after_create` install hook + `before_run`
   precondition real, and lets you validate hook fatal-vs-best-effort + timeout semantics.
5. **A park state** — a non-active **and** non-terminal state (`Human Review`) so the default
   commit-only disposition is `nonactive` (release + **preserve** worktree). This is the primary
   success signal.
6. **A reachable terminal state** — at least one ticket the agent can legitimately drive to `Done`
   (verifiable criterion) to exercise the terminal → **cleanup** path.
7. **Small/cheap/bounded** — tasks finish inside `max_turns` and a low `max_budget_usd`.
8. **Ticket count ≥ `max_concurrent_agents`** (ideally 5+), spread across all priorities and ≥2
   active states, created out of order — to actually stress caps + dispatch ordering.
9. **Failure- and ambiguity-inducible** — deterministic ways to trip the failure-retry, stall, and
   `blocked` paths (a failing `before_run` precondition; a contradictory ticket; an underspecified
   ticket that forces AskUserQuestion).
10. **Clean git source** — `workspace.repo` is a real disposable local repo with ≥1 commit, no
    pre-existing `symphony/*` branches.

## 3. Validation surface (what needs proving)

Behaviors most likely to break in a real run, grouped. `live-only` = unit tests are insufficient,
only an end-to-end run proves it. Full matrix in [Appendix A](#appendix-a--full-validation-matrix).

### High-risk, live-only (must cover)

- **Concurrent dispatch + worktree isolation** — N≥3 independent tickets, disjoint files; no
  git-index/worktree races (serialized by the per-shared-repo mutex in `workspace/git-worktree.ts`).
- **Agent moves tracker state via the semantic tools** — orchestrator observes the new state on
  post-turn refresh and compares state **names** (config + file store both speak names).
- **Terminal disposition → immediate worktree cleanup** (branch preserved in `.repo`).
- **Nonactive disposition (commit-only park) → release WITHOUT cleanup** (workspace preserved). The
  default success path.
- **Continuation re-dispatch on the same session** (`resumeSessionId`, turn N-of-M) and the
  **continuation cap → blocked** transition.
- **input_required / AskUserQuestion → blocked** (not retry); workspace preserved, no re-dispatch
  until `unblock()`.
- **Token/budget accounting** — per-session isolation, non-decreasing global total, `max_budget_usd`
  cap (SDK).
- **MCP concurrency isolation** — `sdkServers` factory yields a _fresh_ server per run (sharing one
  silently dropped the tool for the 2nd+ concurrent agent — regression-tested, keep it covered).

### High-risk, deterministic (stub-friendly, confirm live)

- **before_run hook failure → fatal + retry**; after_run/before_remove failures **swallowed**.
- **Failure retry with equal-jitter exponential backoff** (vs fixed-1s continuation delay) — fire
  several failing tickets at once → decorrelated delays, no thundering herd.
- **CLI-backend tracker bridge** — the agent's tracker tool calls reach the file store over the
  orchestrator's internal Unix-socket bridge (`~/.symphony/tracker.sock`), never directly
  (`packages/core/src/tracker-bridge.ts`).

### Medium-risk, externally driven (need an operator harness — see §7)

- **Stall detection** → abort silent worker + retry.
- **reconcileRunningStates / reconcileBlocked** — out-of-band mid-run state change → correct
  disposition.
- **Operator controls** — terminate / resume / unblock / terminateAll; dashboard CRUD + SSE.
- **Hot-reload of `WORKFLOW.md`** (last-known-good on bad YAML); **startup cleanup**; **graceful
  SIGINT**.

## 4. Recommendation — build `dx`, a tiny stdin→stdout CLI

Four archetypes were designed and scored against the matrix:

| Rank  | Candidate                             | Score  | Why                                                                                                                                                     |
| ----- | ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **`dx` — data-wrangler CLI**          | **89** | Mirrors Symphony-TS's own stack → known-good, fast, offline self-verify gate; clean source of disjoint tickets; realistic multi-class failure injection |
| 2     | `katalib` — algorithm/kata collection | 86     | Best structural parallelism (3 new files per ticket, no shared registration); elegant difficulty gradient — but no conflict probe + hand-rolled gate    |
| 3     | `jsonbox` — Fastify REST API          | 80     | Autoload removes shared router line; `inject()` tests — but proposes **concurrent same-file** tickets (misleading green) + heavier deps                 |
| 4     | `@target/utils` — mini-lodash         | 74     | Broadest checklist but **every** ticket edits the shared barrel `index.ts` → not actually disjoint; least faithful to the core constraint               |

**Winner: `dx`**, with two grafts from `katalib`. The decisive property is that `dx` copies
Symphony-TS's _own_ `tsup + vitest + eslint-flat + pnpm` shapes, so the agent's in-worktree
`pnpm build/test/lint` is a **known-good gate** — the one thing that makes terminal completion
_earned_. The same toolchain doubles as the failure-injection surface.

### Repo shape

```
dx/
  package.json                          # bin: dx → dist/cli.js; scripts: build (tsup), test (vitest), lint, typecheck
  tsconfig.json                         # strict, NodeNext  (copy from symphony-ts)
  tsup.config.ts / eslint.config.mjs / prettier.config.mjs / vitest.config.ts
  pnpm-lock.yaml                        # committed → after_create `npm ci`/`pnpm i` is real
  src/cli.ts                            # argv[2] → dispatch
  src/lib/io.ts                         # shared readStdin/writeStdout — NEVER edited by a ticket
  src/commands/<name>.ts                # one pure stdin→stdout transform per ticket
  src/commands/<name>.test.ts
  src/commands/_registered/<name>.ts    # GRAFT #1: one NEW file per command registration
```

Seed 2–3 starter commands (`echo`, `upper`, `version`) + a README documenting the
"one command = one new file + one test + one `_registered/` file" contract, so agents follow it.
Single commit on `main`; no `symphony/*` branches.

### The three grafts (these are what separate a real test from a misleading one)

- **Graft #1 — structural disjointness.** Register each command via a **new** file
  (`_registered/<name>.ts`), _not_ by appending to a shared `registry.ts`/barrel. Happy-path tickets
  then never co-edit a shared file. (This is exactly what dragged `@target/utils` down to #4.)
- **Graft #2 — sequential conflict probe.** Keep **one** same-file pair, but run it **A → park → B
  off the updated base**, never concurrently. Concurrent same-file tickets each park a green branch
  whose conflict Symphony never resolves in commit-only mode → a _false_ pass. Assert B's branch
  cleanly carries both diffs.
- **Graft #3 — difficulty-gradient blockers.** A _contradictory-acceptance_ ticket (asserts two
  incompatible outcomes; "do not edit the tests") for continuation-cap → blocked; an _underspecified_
  ticket ("do not guess; ask") for AskUserQuestion → blocked.

## 5. Ticket set (14 tickets)

| #   | Path         | Ticket                                            | Touches                                                   | Validates                                                                              |
| --- | ------------ | ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | happy        | `slug` — text → URL-safe slug                     | new `slug.ts`+test+`_registered/slug.ts`                  | concurrency, worktree isolation, nonactive park, status move, after_create npm ci      |
| 2   | happy        | `count --lines/--words/--chars`                   | new files                                                 | saturation, dispatch ordering (priority=high), token per-session isolation             |
| 3   | happy        | `json-keys` — top-level keys of stdin JSON        | new files                                                 | isolation, per-state cap fill (seed in "In Progress")                                  |
| 4   | continuation | `csv2json` (quoting edge cases)                   | new files                                                 | continuation on **same session**, `resumeSessionId` (run under EDGE `max_turns=2`)     |
| 5   | happy        | `dedup` — drop duplicate lines, keep order        | new files                                                 | 5th slot saturates `max_concurrent_agents=5`; priority=none → sorts last               |
| 6   | happy        | `sort --numeric/--reverse`                        | new files                                                 | over-saturate cap → queueing; priority=low; operator terminate/resume target           |
| 7   | terminal     | fix `version` to read `package.json`              | edit `version.ts`+test only                               | terminal → **immediate cleanup**, branch preserved                                     |
| 8   | blocked      | `redact` "match the team format" (ambiguous)      | new files (no edit on block)                              | AskUserQuestion → **blocked**, workspace preserved, no continuation                    |
| 9   | blocked      | make `count` "fully robust" (contradictory)       | edit `count.ts` — **schedule AFTER #2, never concurrent** | continuation-cap → **blocked**; budget cap; `cap=0` must NOT block                     |
| 10  | fail         | `lint-clean` (planted lint violation)             | new file (disjoint)                                       | `before_run` lint precondition → **fatal** → retry w/ equal-jitter backoff             |
| 11  | fail         | `weather` (fetch from a remote API, offline)      | new file (disjoint)                                       | non-hook failure class; failure-vs-continuation delay; `max_failure_retries` → blocked |
| 12  | happy        | `pad` — with slash/space in the ticket identifier | new files                                                 | `sanitizeIdentifier` + path-safety containment; branch created without git-lock errors |
| 13  | slow         | `trim` (deliberately quiet/long)                  | new dir of files                                          | stall detection; reconcile mid-run; operator terminate/resume surface                  |
| 14  | happy        | `wrap` — wrap lines at width                      | new files                                                 | extra disjoint happy ticket to over-saturate the cap and probe queue ordering          |

> Tip: fire #10 (run 2–3 copies) together to _see_ the decorrelated backoff. Batch #1–#6 to
> saturate concurrency. Seed across all priorities and ≥2 active states, **created out of order**.

## 6. Two WORKFLOW profiles

Run the same repo under two configs to cleanly separate the happy/concurrency run from the
cap/blocked/timeout run. Both share the same `tracker` block — the local file store needs no setup:

```yaml
tracker:
  kind: file
  data_root: ~/.symphony # default; one local JSON store, no external services
  project_id: default # active project key → ~/.symphony/projects/default/
  active_states: [Todo, In Progress, Rework, Merging]
  terminal_states: [Done, Cancelled]
  review_state: Human Review # the non-active, non-terminal park state
```

**STRESS** — concurrency, ordering, per-state cap:

```yaml
agent:
  backend: claude-sdk
  permission_mode: bypassPermissions
  max_concurrent_agents: 5
  max_turns: 6
  max_continuations: 50
  max_budget_usd: 2
  max_concurrent_agents_by_state: { 'In Progress': 1 } # throttle one state
```

**EDGE** — caps, blocked, timeout, stall, failure:

```yaml
agent:
  backend: claude-sdk
  max_turns: 2
  max_continuations: 1
  max_failure_retries: 1
  stall_timeout_ms: 60000 # low, for the trim ticket
  max_budget_usd: 1
hooks:
  before_run: 'pnpm lint' # makes the lint-clean ticket a FATAL before_run failure
  timeout_ms: 2000 # tiny, for the hook-timeout check (pair with a deliberate sleep)
```

## 7. Setup + staged validation playbook (cheapest confidence first)

### 7.0 One-time setup

1. `pnpm install && pnpm build` from this directory.
2. `cp WORKFLOW.md.example WORKFLOW.md`; in it set `workspace.repo` to a **disposable local git
   repo** that has at least one commit (the `dx` repo from §4), keep the `tracker` block from §6,
   and pick one of the §6 `agent` profiles.
3. The file store auto-creates `~/.symphony/projects/default/` on first use; the states from config
   are seeded into `states.json` then — **no external board to set up**.
4. Start the orchestrator + dashboard: `node apps/cli/dist/main.js ./WORKFLOW.md --port 4500`
   (or `symphony ./WORKFLOW.md --port 4500`). Dashboard at http://127.0.0.1:4500/.

### 7.1 The runs

1. **Single happy ticket** (STRESS). Seed one ticket:
   `symphony ticket create "Add slug command" --desc "stdin text → URL-safe slug" --state Todo`
   (writes `~/.symphony/projects/default/issues/SYM-1.json`), or use the dashboard's **"+ New
   ticket"**. Then watch the full path: the ticket appears on the board → orchestrator dispatches it
   to a local Claude agent in an isolated git worktree → the agent reads it with `tracker_get_task`,
   moves it to **In Progress**, implements + commits locally, posts a summary via
   `tracker_add_comment`, and moves it to **Human Review** via `tracker_update_status` →
   orchestrator parks it (Human Review is non-active, non-terminal) and **preserves** the
   worktree/branch.
   **Verify:** `~/.symphony/projects/default/issues/SYM-1.json` shows `"state": "Human Review"`;
   `issues/SYM-1/comments.jsonl` has the summary line; the worktree under `workspace.root` exists
   with branch `symphony/SYM-1`; the dashboard shows it parked in the Human Review lane.
2. **Terminal cleanup** — drive the `version` ticket → `Done`. The issue JSON flips to `"Done"` and
   the worktree is **cleaned up immediately** while the `symphony/<id>` branch is preserved in the
   shared `.repo`. Distinguishes cleanup from preserve/park.
3. **Concurrency saturation** — seed #1–#6 at once (CLI loop or the dashboard); spread priorities +
   2 active states, out of order. Watch ≤5 worktrees live, disjoint files, no git-index races.
4. **Continuation + multi-turn** — `csv2json` under EDGE `max_turns=2`; assert turn-2
   `resumeSessionId == turn-1 sessionId`.
5. **Sequential conflict probe** — the one same-file pair, A → park → B (NOT concurrent).
6. **Blocked — input required** — the underspecified ticket → `blocked`; issue JSON keeps its active
   state, no continuation, workspace preserved.
7. **Blocked — continuation cap** — the contradictory ticket under `max_continuations=1`.
8. **Failure retry (two classes)** — batch the lint-precondition tickets + the offline-API ticket;
   watch decorrelated equal-jitter backoff, then `blocked` at `max_failure_retries`.
9. **Hook timeout** — one ticket under tiny `timeout_ms` with a `before_run` that **sleeps** past it
   (don't rely on npm-cache timing).
10. **CLI backend + tmux** — switch `agent.backend: claude-cli` and `agent.tmux: true`, seed one
    happy ticket. The agent's tracker tool calls automatically go through the orchestrator's internal
    Unix-socket bridge (`~/.symphony/tracker.sock`). **Verify:** `tmux attach -t symphony-SYM-1`
    shows live work; the state move to Human Review still lands in the issue JSON; `comments.jsonl`
    has no torn/partial lines.
11. **Multi-project** — in the dashboard, **"+ New project"** → name, identifier (id prefix), repo.
    **Verify:** a new dir appears under `~/.symphony/projects/<key>/` (with `meta.json` +
    `states.json`), and switching projects in the board **live re-points** the orchestrator (tracker
    - repo scope swap, no restart).
12. **Operator harness** (external script, during the long tickets) — see §8.

## 8. Gaps no target repo can self-trigger (need an external driver / stubs)

These are **not** properties of the target project — a ~50-line operator script must drive them while
runs are in flight, and a few are better left to stub-backend unit tests:

- **Stall detection** — claude-sdk emits only at message boundaries, so a "silent-but-alive" worker
  can't be induced from a task without false positives on a slow-but-working turn. Cover with a
  `GatedBackend`/stub; the `trim` ticket only _confirms_ live.
- **Out-of-band reconcile** (`reconcileRunningStates`/`reconcileBlocked`) — moving a running/blocked
  ticket `Done`/`Backlog` mid-run needs a second actor. Edit the issue JSON in place (or use the
  dashboard) while the worker is running, then confirm the orchestrator's next post-turn refresh
  picks the right disposition.
- **Operator controls + dashboard/SSE** — terminate/resume/unblock/terminateAll, board CRUD, label
  name→id, file upload, SSE replay-then-live + 100-event FIFO cap. Interaction-driven.
- **Token/budget exactness** — `max(0, next − lastReported)` delta math + per-session isolation are
  only loosely checkable from outside (sum vs total); precise math → unit tests.
- **Remote/SSH workspace transport** — parse-only in v1; every local target skips it.
- **codex-cli / opencode-cli MCP wiring** — `--mcp-config` is a noted follow-up; the tracker tools +
  bridge are proven only for `claude-sdk` and `claude-cli`.
- **Real merge-conflict resolution** — by construction (commit-only, disjoint files) no target
  exercises actual cross-branch git merge. The grafts prove _isolation_, not _resolution_.

**Complete validation = `dx` repo + ticket set (§5) + the operator harness (§8) + existing
stub-backend unit tests.** No single piece covers everything; that is inherent to an orchestrator.

## 9. Open questions

1. Scaffold the `dx` repo (with `_registered/` discovery + seed commands + both WORKFLOW profiles)?
2. Live-run cost envelope — tickets × turns × `max_budget_usd` you'll spend? Bounds how much of the
   concurrency matrix runs live vs against stubs.
3. Write the operator harness now, or validate the self-triggering rows first and add it later?
4. First-run backend — `claude-sdk` (in-process tracker tools, simplest) or `claude-cli` + tmux
   (watchable, tracker calls over the socket bridge)?

---

## Appendix A — Full validation matrix

`risk` / `live-only` / target condition that exercises each path.

| Feature                                                                                     | Risk   | Live-only | Target condition                                                                  |
| ------------------------------------------------------------------------------------------- | ------ | --------- | --------------------------------------------------------------------------------- |
| Concurrent dispatch + isolated worktrees (no index corruption/cross-issue conflict)         | high   | yes       | ≥3 (ideally 5+) independent tickets touching different files                      |
| Worktree isolation + path-safety (`cwd==worktree`, `assertUnderRoot`, `sanitizeIdentifier`) | high   | yes       | real `symphony/<id>` branches; an identifier with slash/space; agent writes files |
| Agent moves state via the semantic tools; orchestrator observes by state name               | high   | yes       | file tracker; prompt instructs `tracker_update_status` of own state               |
| Terminal disposition → immediate worktree cleanup (branch preserved)                        | high   | yes       | a ticket with verifiable completion → `Done`                                      |
| Nonactive disposition (park) → release WITHOUT cleanup                                      | high   | yes       | non-active non-terminal park state (`Human Review`); agent commits then parks     |
| Continuation re-dispatch on same session (`resumeSessionId`, turn N-of-M)                   | high   | yes       | small `max_turns`; ticket legitimately spans >1 turn while staying active         |
| Continuation cap → blocked (`cap>0`); `cap=0` unlimited                                     | high   | no        | underspecified/impossible ticket + small `max_continuations`                      |
| input_required / AskUserQuestion → blocked (not retry), workspace preserved                 | high   | yes       | genuinely ambiguous ticket; prompt forbids guessing                               |
| Failure retry w/ equal-jitter exp backoff (fixed-1s on continuation)                        | high   | no        | several tickets fail turn-1 at once (before_run exit 1 / unreachable backend)     |
| Stall detection (`reconcileStalls`) aborts silent worker + retry                            | high   | yes       | low `stall_timeout_ms` + a task that goes silent, or a GatedBackend               |
| `reconcileRunningStates` (out-of-band mid-run move) → correct stopIntent                    | high   | yes       | operator edits a running ticket's JSON to Done/non-active mid-turn                |
| `reconcileBlocked` (blocked → terminal cleanup vs non-active release)                       | medium | yes       | blocked ticket later moved to Done vs Backlog                                     |
| Per-state concurrency override (`max_concurrent_agents_by_state`)                           | medium | no        | tickets across ≥2 active states with a cap on one                                 |
| Dispatch ordering (priority asc, createdAt asc, identifier asc; null-last)                  | medium | no        | tickets seeded across all priorities, created out of order                        |
| before_run failure → fatal+retry; after_run/before_remove swallowed                         | high   | no        | hooks where before_run can exit 1 (failing lint/build)                            |
| after_create runs once per fresh worktree; skipped on reuse                                 | medium | yes       | meaningful after_create (npm install / git identity); needs `package.json`        |
| Hook timeout (`hooks.timeout_ms`) → fatal for before_run/after_create                       | medium | no        | a hook that exceeds a small `timeout_ms` (sleep / slow install)                   |
| Token/budget: absolute-only deltas, per-session isolation, `max_budget_usd` cap             | high   | yes       | concurrent real runs; low `max_budget_usd` on SDK                                 |
| Multi-turn session resumption (sessionId carried, result overrides)                         | high   | yes       | ticket requiring ≥2 turns; assert turn-2 `resumeSessionId == turn-1 sessionId`    |
| tmux supervision (CLI backend): session, `run.jsonl` tee, pid, kill-on-abort                | medium | yes       | host with tmux; `claude-cli` + `tmux:true`                                        |
| MCP concurrency isolation: SDK `sdkServers` factory per run; CLI stdio per subprocess       | high   | yes       | `claude-sdk` with ≥2 concurrent runs; fresh server per run                        |
| CLI tracker bridge: agent tool calls funnel over `tracker.sock` to the file store           | high   | yes       | `claude-cli`; agent calls `tracker_update_status`; assert JSON state move         |
| File store durability (atomic writes, per-key mutex, partial-jsonl tolerance)               | medium | yes       | concurrent agents writing the same project; no torn `comments.jsonl` lines        |
| Startup cleanup purges already-terminal worktrees (idempotent)                              | medium | yes       | leftover worktrees + terminal tickets at boot                                     |
| Operator controls: terminate / resume / unblock / terminateAll                              | medium | yes       | long-enough runs; interact via dashboard/API mid-run                              |
| Hot-reload of `WORKFLOW.md` (1s stat-poll; last-known-good on bad reload)                   | medium | yes       | edit config mid-run (valid + invalid YAML)                                        |
| Graceful shutdown (SIGINT/SIGTERM): abort all, no new retries, drain                        | medium | yes       | several running tickets, then SIGINT                                              |
| SSE live log streaming: replay (cap 100) then live; unsubscribe on close                    | low    | yes       | running ticket emitting events; SSE client                                        |
| Dashboard board/detail/CRUD + label name→id + file upload (≤25MB)                           | low    | yes       | file store with labels + multiple states                                          |
| Multi-project switch: "+ New project" scaffolds a dir; switch live re-points orchestrator   | medium | yes       | create a 2nd project in the dashboard, switch to it mid-session                   |
| CLI entrypoint + `ticket create` round-trip to NormalizedIssue                              | low    | yes       | valid `WORKFLOW.md`; create a ticket via CLI → issue JSON file appears            |
| Retry corner cases (no free slots → re-enqueue; retry candidate now non-active → released)  | medium | no        | `max_concurrent_agents=1` + a failing issue + a slot-filler                       |
