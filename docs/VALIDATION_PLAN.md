# Symphony-TS — End-to-End Validation Plan & Target Project

> Findings + recommendation for picking the **simplest project that fully validates Symphony-TS**.
> Authored 2026-06-17 from a multi-agent analysis of the codebase. Companion to `docs/RUNBOOK.md`
> (which covers the mechanics of a single first run); this doc covers _what to validate_ and the
> _target repo + ticket set + playbook_ that exercises the whole feature surface.

## 1. What "testing Symphony-TS" actually means

Symphony-TS is an **orchestrator, not an app**. It polls a self-hosted Plane tracker, gives each
ticket an isolated **git worktree** off one shared clone, and runs a **local Claude Code agent**
until the ticket commits + reaches a terminal/parked state, up to `max_concurrent_agents` at once.
The orchestrator is **read-only** on the tracker; the **agent moves its own ticket** via the
confined `tracker_api` MCP tool.

Therefore "a project to test it" is **a target repo + a set of Plane tickets** that drive the agents.
The validation question is: _which repo + tickets exercise the most real Symphony behavior, cheaply?_

## 2. The dominant constraint (drives every other decision)

`blockedBy` is hardcoded `[]` (`packages/tracker/src/plane/normalize.ts:90`,
`packages/tracker/src/memory/memory-tracker.ts:145`) — Plane exposes no issue relations, so there is
**zero automatic dependency ordering**. Anything that runs concurrently must be **independent and
touch disjoint files**, or worktrees silently co-edit the same lines, each branch parks a _fake_
"success", and the conflict is never resolved (commit-only mode performs no cross-branch merge).

This single fact rules out most "real app" ideas (tickets stack on each other) and forces a project
of **many small, independent, individually test-verifiable units**.

### Hard requirements for the target repo + ticket set

1. **Independent tickets** — no ticket's correctness depends on another's output.
2. **Disjoint files in parallel** — concurrently-dispatched tickets create/edit different files/dirs.
3. **Self-verifiable** — the agent can run `build`/`test`/`lint` in-worktree so terminal completion is
   _earned_, not hallucinated. Needs a fast, offline toolchain.
4. **Has `package.json`** (or equivalent) — makes the `after_create` install hook + `before_run`
   precondition real, and lets you validate hook fatal-vs-best-effort + timeout semantics.
5. **A park state** — a non-active **and** non-terminal Plane state (`Human Review`) so the default
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
10. **Clean git source** — `workspace.repo` is a real repo with ≥1 commit, no pre-existing
    `symphony/*` branches.

## 3. Validation surface (what needs proving)

Behaviors most likely to break in a real run, grouped. `live-only` = unit tests are insufficient,
only an end-to-end run proves it. Full matrix in [Appendix A](#appendix-a--full-validation-matrix).

### High-risk, live-only (must cover)

- **Concurrent dispatch + worktree isolation** — N≥3 independent tickets, disjoint files; no
  git-index/worktree races (serialized by the per-shared-repo mutex in `workspace/git-worktree.ts`).
- **Agent moves tracker state via `tracker_api`** — orchestrator observes it on post-turn refresh and
  joins state **UUID → name** (Plane mutates by UUID, config compares by name).
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
- **`tracker_api` path-confinement** — rejects `DELETE`, `../`, `//`, `/api/`, `%2e%2e`, wrong
  prefixes; allows project-relative `GET/POST/PATCH` (`packages/tracker/src/tools/plane-rest.ts`).

### Medium-risk, externally driven (need an operator harness — see §7)

- **Stall detection** → abort silent worker + retry.
- **reconcileRunningStates / reconcileBlocked** — out-of-band mid-run state change → correct
  disposition.
- **Operator controls** — terminate / resume / unblock / terminateAll; dashboard CRUD + SSE.
- **Hot-reload of `WORKFLOW.md`** (last-known-good on bad YAML); **startup cleanup**; **graceful
  SIGINT**; **Plane REST resilience** (429/5xx/Retry-After backoff).

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

| #   | Path         | Ticket                                                   | Touches                                                   | Validates                                                                                         |
| --- | ------------ | -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | happy        | `slug` — text → URL-safe slug                            | new `slug.ts`+test+`_registered/slug.ts`                  | concurrency, worktree isolation, nonactive park, tracker_api PATCH, after_create npm ci           |
| 2   | happy        | `count --lines/--words/--chars`                          | new files                                                 | saturation, dispatch ordering (priority=high), token per-session isolation                        |
| 3   | happy        | `json-keys` — top-level keys of stdin JSON               | new files                                                 | isolation, per-state cap fill (seed in "In Progress")                                             |
| 4   | continuation | `csv2json` (quoting edge cases)                          | new files                                                 | continuation on **same session**, `resumeSessionId` (run under EDGE `max_turns=2`)                |
| 5   | happy        | `dedup` — drop duplicate lines, keep order               | new files                                                 | 5th slot saturates `max_concurrent_agents=5`; priority=none → sorts last                          |
| 6   | happy        | `sort --numeric/--reverse`                               | new files                                                 | over-saturate cap → queueing; priority=low; operator terminate/resume target                      |
| 7   | terminal     | fix `version` to read `package.json`                     | edit `version.ts`+test only                               | terminal → **immediate cleanup**, branch preserved                                                |
| 8   | blocked      | `redact` "match the team format" (ambiguous)             | new files (no edit on block)                              | AskUserQuestion → **blocked**, workspace preserved, no continuation                               |
| 9   | blocked      | make `count` "fully robust" (contradictory)              | edit `count.ts` — **schedule AFTER #2, never concurrent** | continuation-cap → **blocked**; budget cap; `cap=0` must NOT block                                |
| 10  | fail         | `lint-clean` (planted lint violation)                    | new file (disjoint)                                       | `before_run` lint precondition → **fatal** → retry w/ equal-jitter backoff                        |
| 11  | fail         | `weather` (fetch from a remote API, offline)             | new file (disjoint)                                       | non-hook failure class; failure-vs-continuation delay; `max_failure_retries` → blocked            |
| 12  | security     | `noop`, after attempting a disallowed `tracker_api` call | new files                                                 | path-confinement wired into the **live** executor (`DELETE`/`../`/`//`/`%2e%2e`/`/api/` rejected) |
| 13  | happy        | `pad` — with slash/space in the ticket identifier        | new files                                                 | `sanitizeIdentifier` + path-safety containment; branch created without git-lock errors            |
| 14  | slow         | `trim` (deliberately quiet/long)                         | new dir of files                                          | stall detection; reconcile mid-run; operator terminate/resume surface                             |

> Tip: fire #10 (run 2–3 copies) together to _see_ the decorrelated backoff. Batch #1–#6 to
> saturate concurrency. Seed across all 5 priorities and 2 active states, **created out of order**.

## 6. Two WORKFLOW profiles

Run the same repo under two configs to cleanly separate the happy/concurrency run from the
cap/blocked/timeout run.

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

## 7. Staged validation playbook (cheapest confidence first)

1. **Offline smoke** — `SYMPHONY_DRYRUN_TICKETS=1 node scripts/dry-run-claude.mjs` (no Plane). Proves
   the whole loop wires up: dispatch → worktree → after_create → real turn → commit → in-process
   tracker_api park → release + preserve.
2. **Single happy ticket, live Plane** (STRESS, seed only `dx slug`). Live PlaneTracker round-trip +
   nonactive park, no concurrency confound; UUID→name join; after_create npm ci real.
3. **Terminal cleanup** — `version` → `Done`. Distinguishes cleanup from preserve/park.
4. **Concurrency saturation** — release #1–#6 at once; spread priorities + 2 states, out of order.
5. **Continuation + multi-turn** — `csv2json` under EDGE `max_turns=2`.
6. **Sequential conflict probe** — the one same-file pair, A → park → B (NOT concurrent).
7. **Blocked — input required** — the underspecified ticket.
8. **Blocked — continuation cap** — the contradictory ticket under `max_continuations=1`.
9. **Failure retry (two classes)** — batch the lint-precondition tickets + the offline-API ticket.
10. **Hook timeout** — one ticket under tiny `timeout_ms` with a `before_run` that **sleeps** past it
    (don't rely on npm-cache timing).
11. **Security probe** — the `tracker_api` confinement ticket.
12. **Operator harness** (external script, during the long tickets) — see §8.

## 8. Gaps no target repo can self-trigger (need an external driver / stubs)

These are **not** properties of the target project — a ~50-line operator script must drive them while
runs are in flight, and a few are better left to stub-backend unit tests:

- **Stall detection** — claude-sdk emits only at message boundaries, so a "silent-but-alive" worker
  can't be induced from a task without false positives on a slow-but-working turn. Cover with a
  `GatedBackend`/stub; the `trim` ticket only _confirms_ live.
- **Out-of-band reconcile** (`reconcileRunningStates`/`reconcileBlocked`) — moving a running/blocked
  ticket `Done`/`Backlog` mid-run needs a second actor (operator script or second agent).
- **Operator controls + dashboard/SSE** — terminate/resume/unblock/terminateAll, board CRUD, label
  name→id, file upload, SSE replay-then-live + 100-event FIFO cap. Interaction-driven.
- **Plane REST resilience** — 429/408/5xx + Retry-After backoff, 30s timeout. Needs a flaky proxy in
  front of Plane or killing/slowing the Plane container.
- **Token/budget exactness** — `max(0, next − lastReported)` delta math + per-session isolation are
  only loosely checkable from outside (sum vs total); precise math → unit tests.
- **Remote/SSH workspace transport** — parse-only in v1; every local target skips it.
- **codex-cli / opencode-cli MCP wiring** — `--mcp-config`/`tracker_api` is a noted follow-up; MCP
  isolation + confinement are proven only for `claude-sdk` and `claude-cli`.
- **Real merge-conflict resolution** — by construction (commit-only, disjoint files) no target
  exercises actual cross-branch git merge. The grafts prove _isolation_, not _resolution_.

**Complete validation = `dx` repo + ticket set (§5) + the operator harness (§8) + existing
stub-backend unit tests.** No single piece covers everything; that is inherent to an orchestrator.

## 9. Open questions

1. Scaffold the `dx` repo (with `_registered/` discovery + seed commands + both WORKFLOW profiles)?
2. Is local Plane configured with the exact states — active `[Todo, In Progress, Rework, Merging]`,
   park `Human Review` (started, non-terminal), terminal `[Done, Cancelled]`, plus `Backlog`?
   (mismatch = silent no-dispatch)
3. Live-run cost envelope — tickets × turns × `max_budget_usd` you'll spend? Bounds how much of the
   concurrency matrix runs live vs against stubs.
4. Write the operator harness now, or validate the self-triggering rows first and add it later?
5. First-run backend — `claude-sdk` (in-process MCP, simplest) or `claude-cli` + tmux (watchable)?

---

## Appendix A — Full validation matrix

`risk` / `live-only` / target condition that exercises each path.

| Feature                                                                                     | Risk   | Live-only | Target condition                                                                  |
| ------------------------------------------------------------------------------------------- | ------ | --------- | --------------------------------------------------------------------------------- |
| Concurrent dispatch + isolated worktrees (no index corruption/cross-issue conflict)         | high   | yes       | ≥3 (ideally 5+) independent tickets touching different files                      |
| Worktree isolation + path-safety (`cwd==worktree`, `assertUnderRoot`, `sanitizeIdentifier`) | high   | yes       | real `symphony/<id>` branches; an identifier with slash/space; agent writes files |
| Agent moves state via `tracker_api`; orchestrator observes + UUID→name join                 | high   | yes       | live Plane; prompt instructs PATCH of own state UUID                              |
| Terminal disposition → immediate worktree cleanup (branch preserved)                        | high   | yes       | a ticket with verifiable completion → `Done`                                      |
| Nonactive disposition (park) → release WITHOUT cleanup                                      | high   | yes       | non-active non-terminal park state (`Human Review`); agent commits then parks     |
| Continuation re-dispatch on same session (`resumeSessionId`, turn N-of-M)                   | high   | yes       | small `max_turns`; ticket legitimately spans >1 turn while staying active         |
| Continuation cap → blocked (`cap>0`); `cap=0` unlimited                                     | high   | no        | underspecified/impossible ticket + small `max_continuations`                      |
| input_required / AskUserQuestion → blocked (not retry), workspace preserved                 | high   | yes       | genuinely ambiguous ticket; prompt forbids guessing                               |
| Failure retry w/ equal-jitter exp backoff (fixed-1s on continuation)                        | high   | no        | several tickets fail turn-1 at once (before_run exit 1 / unreachable backend)     |
| Stall detection (`reconcileStalls`) aborts silent worker + retry                            | high   | yes       | low `stall_timeout_ms` + a task that goes silent, or a GatedBackend               |
| `reconcileRunningStates` (out-of-band mid-run move) → correct stopIntent                    | high   | yes       | operator moves a running ticket Done/non-active mid-turn                          |
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
| `tracker_api` path-confinement (rejects DELETE/`..`/`//`/`/api/`/`%2e%2e`)                  | high   | no        | agent attempts each escape vector; assert refusal                                 |
| Plane REST resilience (429/408/5xx + Retry-After; 30s timeout; UUID↔name memoized)          | medium | yes       | flaky transport / kill or slow Plane mid-run                                      |
| Startup cleanup purges already-terminal worktrees (idempotent)                              | medium | yes       | leftover worktrees + terminal tickets at boot                                     |
| Operator controls: terminate / resume / unblock / terminateAll                              | medium | yes       | long-enough runs; interact via dashboard/API mid-run                              |
| Hot-reload of `WORKFLOW.md` (1s stat-poll; last-known-good on bad reload)                   | medium | yes       | edit config mid-run (valid + invalid YAML)                                        |
| Graceful shutdown (SIGINT/SIGTERM): abort all, no new retries, drain                        | medium | yes       | several running tickets, then SIGINT                                              |
| SSE live log streaming: replay (cap 100) then live; unsubscribe on close                    | low    | yes       | running ticket emitting events; SSE client                                        |
| Dashboard board/detail/CRUD + label name→id + file upload (≤25MB)                           | low    | yes       | live Plane with labels + multiple states                                          |
| CLI entrypoint + `ticket create` round-trip to NormalizedIssue                              | low    | yes       | valid `WORKFLOW.md`; create a ticket via CLI against live Plane                   |
| Retry corner cases (no free slots → re-enqueue; retry candidate now non-active → released)  | medium | no        | `max_concurrent_agents=1` + a failing issue + a slot-filler                       |
