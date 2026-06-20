# TODO — LLM-assisted ticket Sequencing ("Sequence" tab)

Plan: `~/.claude/plans/act-as-senior-software-expressive-frog.md`
Defaults locked: Sequence tab · hybrid rank+blockedBy · approve→move to Todo · repo-aware LLM.

## P1 — Data model + dispatch enforcement ✓ (build + typecheck + tracker/core tests green)

- [x] `rank?: number` on `NormalizedIssue` (shared/src/issue.ts)
- [x] `rank` in `storedIssueSchema` (tracker/file/store.ts)
- [x] `IssuePatch`: `rank?: number|null` + `blockedBy?: Blocker[]` (tracker/tracker.ts)
- [x] adapter `toNormalized` rank spread; `updateIssue` rank+blockedBy patches (tracker/file/adapter.ts)
- [x] `sortForDispatch` rank-primary; rename `todoBlockedByNonTerminal` → `blockedByNonTerminal` (dispatch.ts)
- [x] `shouldDispatch` gate generalization (orchestrator.ts) + core index export
- [x] blocker liveness refresh `refreshBlockerStates` in `fetchCandidateIssues` (file adapter + memory)
- [x] board column sort by rank + `blocked_by`/`rank` DTOs (dashboard-source, client api.ts)
- [x] tests: dispatch.test.ts (rank/gate) + adapter round-trip + liveness refresh; fixed orchestrator blocker test

## P2 — Order-run backend ✓ (build + typecheck + new tests green)

- [x] `sdk-order-tools.ts` (+ extracted shared `askTool`/`ASK_SCHEMA`) + `validateOrderSubmission` (agent-backends)
- [x] `order-worker.ts` (core)
- [x] `order-prompt.ts` + `DEFAULT_ORDER_SYSTEM_PROMPT` (core)
- [x] `OrderRun`/`OrderProposal` types (shared) + `OrderStore`+`supportsOrderStore` (tracker) + `orders/<runId>.json` persistence + memory impl
- [x] `orderSchema` + register + `OrderConfig` (config/schema.ts)
- [x] tests: sdk-order-tools validation + OrderStore round-trip/reload

## P3 — Orchestrator lifecycle + commit ✓ (build + typecheck + 154 core tests green)

- [x] `state.orderRuns` + `PendingAsk.runId` + `OrderRunEntry`
- [x] startOrder/dispatchOrder/onOrderAsk/onOrderSubmit/onOrderWorkerExit/answerOrderQuestion/reRunOrder/cancelOrder/getOrder/listOrders
- [x] availableSlots / subscribeLogs / getSessionLogs / stop / switchProject + startPlan overlap guard
- [x] `approveOrder` → `commitOrder` (rank + edge-filtered blockedBy → acyclic by construction + move to entry lane). (Used `updateIssue` loop, not a separate `setSequence`.)
- [x] tests: order.test.ts (submit→ready, approve commits+moves, override drops edge, subset guards, self-correct submission)

## P4 — Dashboard API + server + DashboardSource ✓ (build + typecheck + 30 dashboard tests green)

- [x] DashboardSource: `startOrder/getOrder/listOrders/answerOrderQuestion/reRunOrder/approveOrder/cancelOrder` + `order` capability
- [x] server.ts: `/api/v1/orders` (POST/GET), `/:runId` (GET), `/answer|rerun|approve|cancel` (POST), `/:runId/logs` (SSE)
- [x] api.ts: `OrderDTO` types + client methods + `orderLogStream` + `Capabilities.order`
- [x] tests: order start/approve routing + capabilities

## P5 — Sequence tab UI ✓ (client build + typecheck green)

- [x] `sequence.tsx` (picker, 2-step stepper, SSE log via `orderLogStream`, native-DnD reorder list with rationale + blocked-by chips + drag warnings, approve/rerun/cancel, refresh-resume via listOrders)
- [x] exported `QuestionCard` from plan.tsx for reuse
- [x] `app.tsx` tab wiring (gated on `caps.order`); `styles.css` `.seq-*` block

## P6 — Docs + gates ✓

- [x] CLAUDE.md invariants update (5th write-spot `commitOrder`; `blockedBy` now live + liveness refresh; Sequence-mode summary)
- [x] `pnpm build && pnpm test (300) && pnpm typecheck && pnpm lint && pnpm format:check` — all green

## P7 — Surface dependencies/order on card + detail ✓ (build + typecheck + lint + format green)

- [x] Card (`board.tsx`): `#k` sequence pill in top-right (ordered vs not at a glance) + "⛓ needs SYM-x" dependency line under the title
- [x] Ticket detail (`modals.tsx`): read-only "Sequence" section — "#k in queue" pill + "blocked by" dependency chips (from detail, falls back to card values)
- [x] `styles.css`: `.pill.seq`, `.card-deps`, `.dep-icon`, `.seq-info`, `.seq-deps`
- (Data already flowed via `rank`/`blocked_by` on BoardIssueDTO + IssueDetailDTO from P1/P4.)

## P8 — "Apply (keep in Backlog)" + visibility fix ✓ (build + 301 tests + typecheck + lint + format green)

- [x] `approveOrder(runId, finalOrder?, release=true)` + `commitOrder(run, order, move)` — `release:false` commits rank+blockedBy but keeps tickets in Backlog (no state move, no scheduleTick)
- [x] `OrderRun.released` flag persisted (shared + store schema + client OrderDTO); approved banner reflects queued vs kept-in-Backlog
- [x] server route parses `release`; api client `approveOrder(runId, order?, release=true)`
- [x] sequence.tsx: second button **"Apply (keep in {Backlog})"** beside "Approve & queue"; shared `approve(runId, release)` helper
- [x] return field renamed `moved` → `applied`; tests updated (+ keep-in-backlog order test, +server release-flag assertions)
- Note: badges only appear AFTER commit (Apply/Approve) — a "ready" proposal writes nothing to tickets yet. That was the "nothing on cards" cause.

## Follow-ups / not yet done

- Manual end-to-end validation with a live claude-sdk agent + real repo (needs creds + a project) — see plan Verification §2-3.
- Optional Playwright smoke of the Sequence tab against a stub source (mirrors prior modal-redesign validation).

---

# TODO — Dashboard modal redesign (New Ticket · Ticket Detail · Projects) — DONE (prior session)

Plan: `~/.claude/plans/act-as-software-developer-twinkling-candle.md`

Decisions (locked): full-parity ticket detail (+backend); skip comment-source/type-badge; project
remove = unregister-only (keep disk, guard active).
Defaults: Assignee read-only from backend agent; Delete disabled while a session runs; re-point active
project = explicit confirm.

## Phase 1 — Backend (tracker → core → server) ✓ (builds + typechecks)

- [x] tracker: `deleteIssue`, `detachFromIssue` (store + adapter + interface + MemoryTracker)
- [x] core dashboard-source: `IssueDetailDTO.attachments`, expose in `getIssueDetail`
- [x] core dashboard-source: `deleteIssue`, `addAttachment`, `removeAttachment`
- [x] core dashboard-source: `removeProject`, `updateProject`
- [x] server: DELETE /issues/:id, POST+DELETE /issues/:id/attachments, DELETE+PATCH /projects/:id

## Phase 2 — Frontend API ✓

- [x] api.ts: deleteIssue, addAttachment, removeAttachment, removeProject, updateProject, refresh + DTO field

## Phase 3 — Frontend UI ✓ (builds + typechecks)

- [x] CreateTicketModal restyle (header/close, Agent subsection)
- [x] TicketModal: desc card, attachments, dispatch, overflow menu, assignee, updated, delete footer
- [x] ManageProjectsModal + switcher entry + app.tsx mount
- [x] styles.css additions

## Phase 4 — Tests + gates ✓

- [x] server.test.ts (delete/attachments/project update+remove) + tracker tests (delete/detach/attachments-on-normalized)
- [x] build ✓ · 233 tests ✓ · typecheck ✓ · lint ✓ · format:check ✓ (only pre-existing untracked `.codex/*.md` warn — not ours)
- [x] dark+light validation via Playwright against a stub source (no orchestrator/agents): New Ticket, Ticket detail, Manage Projects — all render faithfully in both themes

DONE. Screenshots: /tmp/sym-shots/{new-ticket,ticket,manage-projects}-{dark,light}.png

## Phase 5 — No preconfigured "default" project ✓ (build + 249 tests + typecheck + lint green)

- [x] Deleted on-disk dirs: demo, website, default (kept example-project, the active one)
- [x] `NullTracker` (inert, no disk) + runtime: file tracker with unset `project_id` → NullTracker;
      dropped the `?? 'default'` fallbacks (runtime + dashboard-source); `buildMcpConfig` skips when none
- [x] `capabilities.activeProject` flag; `closeProject` source method + `POST /projects/close`;
      `hasActiveProject` guards workspace `init()` at CLI boot
- [x] Dashboard empty-state ("No project open → Open / Create") + New-ticket gated; "Close project"
      button in Manage Projects; `WORKFLOW.md.example` no longer preconfigures `project_id: default`
- [x] Tests: NullTracker unit, runtime no-project, server close route; visually validated empty-state
