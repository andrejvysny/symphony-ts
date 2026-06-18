# TODO — Remove Plane + Docker/MinIO → local file tracker + Option A dashboard ✓ DONE

Plan: `~/.claude/plans/act-as-senior-software-abundant-duckling.md`
Branch: `feat/remove-plane-local-file-store`

Decisions: Option A (Refined Kanban) · per-issue JSON files · keep multi-project · keep all
backends · `data_root` default `~/.symphony` · CLI writes via orchestrator Unix-socket bridge ·
attachments saved as local files.

Gate (all green): `pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check` (203 tests).

## Phases — ALL DONE

- [x] **P1 Config** — `tracker.kind:'file'` (now the default) + `data_root`; resolve expands data_root.
- [x] **P2 FileTracker store + adapter** — `packages/tracker/src/file/{store,adapter}.ts` (+ tests),
      drop-in for the Tracker interface. Atomic temp+rename writes, process-wide per-file async mutex,
      persisted `next_seq`/identifier in `meta.json`.
- [x] **P3 file-semantic tools** — `tools/file-semantic.ts` (+ tests). Same wire output; raw `tracker_api` dropped.
- [x] **P4 IPC bridge + runtime** — `core/src/tracker-bridge.ts` (Unix socket) + `buildTracker`/`buildMcpConfig`
      file branch (SDK in-process; CLI stdio env `SYMPHONY_TRACKER_SOCK`/`SYMPHONY_AGENT_STATES`). CLI starts it.
- [x] **P5 stdio server → bridge client** — `stdio-tracker-server.ts` rewritten as a thin socket client (+ tests).
- [x] **P6 dashboard-source + defaults** — file project ops (list/create/switch), createTicket,
      `/api/v1/uploads` route; `capabilities.projects` for file+store.
- [x] **P7 system prompt** — de-Plane wording (tool names unchanged).
- [x] **P8 Delete Plane + Docker/MinIO** — removed `plane/*`, `tools/plane-*`, `http/transport.ts`,
      `infra/plane/`, `plane:*` scripts, plane config fields + `PLANE_API_KEY` fallback + `allow_raw_tracker_api`,
      validate plane block. `TRACKER_MIGRATION.md` retired.
- [x] **P9 Option A dashboard** — Plane UI text removed; on-card signals/rails/drawer already present; client builds.
- [x] **P10 Docs** — README, docs/RUNBOOK.md, docs/VALIDATION_PLAN.md, CLAUDE.md, WORKFLOW.md(.example) rewritten.

## Verify — DONE

- [x] Full gate green (build + 203 tests + typecheck + lint + format:check). `infra/` gone; no plane/docker/minio in source.
- [x] CLI `ticket create` writes `~/.symphony/projects/default/issues/SYM-1.json` (real-binary smoke test).
- [x] CLI + dashboard boot: bridge socket listening, board/capabilities/projects served, agent binary detected.
- [ ] (needs your repo + live run) full SDK/CLI agent round-trip to "Human Review"; dashboard 2nd-project switch.
