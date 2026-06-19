# TODO — Dashboard modal redesign (New Ticket · Ticket Detail · Projects)

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
