# TRACKER_MIGRATION.md — Migrate Symphony-TS off Linear Cloud → self-hosted Plane

> **Purpose of this file.** Symphony-TS currently depends on **Linear Cloud**
> (`https://api.linear.app/graphql`, `LINEAR_API_KEY`). The goal is a **fully local /
> self-hosted** tracker with no SaaS dependency. This document is a complete, self-contained
> implementation brief: paste it into a fresh Claude Code session and execute it.
>
> Decision is already made (see §2). Do **not** re-litigate the tool choice unless an
> Open Question in §12 blocks you.

---

## 1. Current state (what we are replacing)

Symphony talks to Linear in **two distinct layers**. Both must move.

### Layer A — Orchestrator tracker (read + reconcile + write)

The orchestrator polls/reads through the `Tracker` interface; an adapter (`LinearTracker`)
implements it over Linear GraphQL.

- `packages/tracker/src/tracker.ts` — interface contract (`Tracker`, `IssueCreator`, `BoardReader`, `IssueWriter`).
- `packages/tracker/src/linear/` — `adapter.ts`, `client.ts`, `queries.ts`, `normalize.ts` (+ tests).
- `packages/shared/src/issue.ts` — `NormalizedIssue`, `Blocker`, `IssueStateRef` (tracker-neutral; **do not change**).
- `packages/tracker/src/memory/memory-tracker.ts` — in-memory reference impl (keep; it's the test double + the template for the new adapter).

### Layer B — Agent-facing tool (the hard part)

The coding agent mutates the tracker itself, **not** the orchestrator. It does so via an MCP
tool called `linear_graphql` that runs **raw Linear GraphQL**, and the `WORKFLOW.md` prompt
contains **hardcoded Linear GraphQL operations** the agent is told to run.

- `packages/tracker/src/tools/linear-graphql.ts` — `makeLinearGraphqlExecutor` (transport-neutral; takes `{query, variables}`).
- `packages/tracker/src/tools/stdio-linear-server.ts` — standalone stdio MCP server (CLI backends), reads `LINEAR_API_KEY` / `SYMPHONY_LINEAR_ENDPOINT`.
- `packages/agent-backends/src/mcp/sdk-linear-tool.ts` — in-process SDK MCP server (`claude-sdk` backend), tool name `linear_graphql`.
- `packages/core/src/runtime.ts` — `buildTracker()` (dispatch by `tracker.kind`) and `buildMcpConfig()` (wires the tool into MCP for both backend families).
- `WORKFLOW.md` + `WORKFLOW.md.example` — **prompt body (≈ lines 46–79) hardcodes 3 Linear GraphQL operations** (resolve state id → `issueUpdate` → `commentCreate`).

### Layer C — Config + docs

- `packages/core/src/config/schema.ts` — `trackerSchema`, `endpoint` default `https://api.linear.app/graphql`, `DEFAULT_ACTIVE_STATES` / `DEFAULT_TERMINAL_STATES`.
- `packages/core/src/config/resolve.ts` — `tracker.api_key` falls back to `LINEAR_API_KEY`.
- `packages/core/src/config/validate.ts` — linear validation.
- `README.md`, `docs/RUNBOOK.md`, `CLAUDE.md`, `TODO.md` — Linear setup/troubleshooting.

> **Key insight that shapes everything below:** all viable self-hosted trackers are **REST,
> not GraphQL**. So Layer B cannot be a 1:1 swap — the raw-GraphQL tool becomes a **REST
> tool**, and the hardcoded GraphQL in `WORKFLOW.md` must be rewritten as REST calls.

---

## 2. Decision: **Plane** (self-hosted, `makeplane/plane`)

**Chosen tracker: Plane Community Edition.** It is the closest match to Linear's data model
and the lowest-friction migration.

### Why Plane

| Criterion            | Plane                                                                             | Why it wins here                                                                                            |
| -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Workflow-state model | **Typed state groups**: `backlog / unstarted / started / completed / cancelled`   | Maps **directly** onto `WorkflowStateInfo.type` and Symphony's active/terminal split — almost no impedance. |
| Data model           | Issues w/ states, **priority**, **labels**, comments, attachments, cycles/modules | Covers every `NormalizedIssue` field except branch name (synthesizable) and relations (see caveat).         |
| Self-host            | One-command Docker Compose; Community Edition free, no user cap                   | Truly local; runs on the homelab.                                                                           |
| API                  | REST `/api/v1/`, `X-API-Key` auth                                                 | Stable, documented, scriptable.                                                                             |
| Maturity             | ~47k★, actively developed (v2.x, 2026)                                            | Safe long-term bet.                                                                                         |
| License              | AGPL-3.0                                                                          | OK for internal/self-host use.                                                                              |

### Runner-up (fallback): **OpenProject**

Choose OpenProject **only if** issue **blocking relations** turn out to be load-bearing for
the orchestrator (see caveat) and the Plane workaround is unacceptable. OpenProject has full
typed relations (`blocks`/`blocked`) in its community REST API, but is heavier (Rails, ~8 GB
RAM) and uses a HATEOAS response style that costs more integration work. **Not chosen by
default** because its data model is less Linear-like and the agent-prompt rewrite is fiddlier.

### The one Plane caveat — `blockedBy` relations

`NormalizedIssue.blockedBy: Blocker[]` is populated from Linear's `inverseRelations` where
`type === 'blocks'`. **Plane's public `/api/v1/` does not reliably expose issue relations.**

Decision for this migration:

1. **Default:** map `blockedBy` to `[]` (empty) in the Plane adapter. This is safe for a
   single-developer local pipeline — the orchestrator simply won't auto-skip blocked issues.
   Manage blocking by keeping blocked issues out of the `active_states` instead.
2. If blocking is needed later, attempt Plane's internal relation endpoint
   (`.../issues/{id}/issue-relation/`) behind a feature flag, or switch to OpenProject.

**This must be called out in code (a `// LIMITATION:` comment) and in `docs/RUNBOOK.md`.** Do
not silently drop it.

---

## 3. Provision Plane (one-time, before coding)

> Adjust to the user's homelab conventions. Plane self-host docs:
> https://developers.plane.so/self-hosting/methods/docker-compose

1. **Deploy** (Docker Compose):
   ```bash
   curl -fsSL https://github.com/makeplane/plane/releases/latest/download/setup.sh | sh
   # or clone makeplane/plane and use ./setup.sh ; then docker compose up -d
   ```
   Result: web UI on `http://<host>:80` (call this `PLANE_ENDPOINT`, e.g. `http://10.0.0.x`).
2. **Create** a Workspace and a Project in the UI. Note:
   - `WORKSPACE_SLUG` (from the URL `/<workspace-slug>/`).
   - `PROJECT_ID` (UUID, from project settings URL).
   - Project **identifier** prefix (e.g. `SYM`) — used to build issue identifiers like `SYM-12`.
3. **Configure workflow states** in the project to match Symphony's flow. Recommended states
   and their **group** (group is what matters for Symphony semantics):
   | State name | group | Symphony role |
   |---|---|---|
   | `Todo` | `unstarted` | active (dispatch) |
   | `In Progress` | `started` | active |
   | `Rework` | `started` | active |
   | `Merging` | `started` | active |
   | `Human Review` | `started` | parked (agent moves here when it needs a human) |
   | `Done` | `completed` | terminal |
   | `Canceled` | `cancelled` | terminal |
   These names feed `active_states` / `terminal_states` in `WORKFLOW.md`. Keep them aligned
   with whatever the agent prompt references (esp. `Human Review`).
4. **Create an API token**: Workspace/Profile → Settings → **API Tokens** → generate.
   Export as `PLANE_API_KEY`.
5. **Smoke-test the API** (confirms endpoints/version before you write the adapter):
   ```bash
   curl -s -H "X-API-Key: $PLANE_API_KEY" \
     "$PLANE_ENDPOINT/api/v1/workspaces/$WORKSPACE_SLUG/projects/$PROJECT_ID/states/" | jq .
   curl -s -H "X-API-Key: $PLANE_API_KEY" \
     "$PLANE_ENDPOINT/api/v1/workspaces/$WORKSPACE_SLUG/projects/$PROJECT_ID/issues/" | jq '.results[0]'
   ```
   **Record the actual field names returned** — Plane's API moves; the mapping in §5 is the
   expected shape but **verify it against the live instance and adjust**.

---

## 4. Plane REST API — endpoint reference

Base: `{PLANE_ENDPOINT}/api/v1/workspaces/{WORKSPACE_SLUG}/projects/{PROJECT_ID}`
Auth header on every request: `X-API-Key: {PLANE_API_KEY}`
Pagination: cursor-based — response carries `next_cursor` + `next_page_results` (bool); pass
`?cursor={next_cursor}&per_page=100`. Loop until `next_page_results === false`.

| Operation                 | Method + path                                    | Notes                                                                                                                  |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| List issues               | `GET /issues/`                                   | Filter by state: `?state={state_uuid}` (repeatable) or fetch all + filter client-side by state name. Cursor-paginated. |
| Get issue                 | `GET /issues/{issue_id}/`                        |                                                                                                                        |
| Create issue              | `POST /issues/`                                  | body: `{ name, description_html?, state?, priority? }`                                                                 |
| Update issue (move state) | `PATCH /issues/{issue_id}/`                      | body: `{ state: "{state_uuid}" }`                                                                                      |
| List workflow states      | `GET /states/`                                   | each: `{ id, name, color, group, sequence }`; `group ∈ backlog/unstarted/started/completed/cancelled`                  |
| List labels               | `GET /labels/`                                   | map id→name to resolve issue label names                                                                               |
| List comments             | `GET /issues/{issue_id}/comments/`               |                                                                                                                        |
| Add comment               | `POST /issues/{issue_id}/comments/`              | body: `{ comment_html: "<p>…</p>" }`                                                                                   |
| Attachments               | `GET/POST /issues/{issue_id}/issue-attachments/` | Plane uses an S3-style presigned upload flow; verify exact route on the instance.                                      |

Verify each route against the running version during Phase 0 smoke test.

---

## 5. Data-model mapping (Plane issue → `NormalizedIssue`)

`NormalizedIssue` (in `packages/shared/src/issue.ts`) is the tracker-neutral contract — **keep
it unchanged**. The Plane adapter normalizes into it:

| `NormalizedIssue` field | Source from Plane                                        | Transform                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | issue `id` (UUID)                                        | as-is                                                                                                                                                              |
| `identifier`            | `{project_identifier}-{sequence_id}`                     | build string, e.g. `SYM-12`. `sequence_id` is on the issue; `project_identifier` from project meta (fetch once, cache).                                            |
| `title`                 | `name`                                                   | as-is                                                                                                                                                              |
| `description`           | `description_stripped` or `description_html`             | prefer plaintext; coalesce empty → `null`                                                                                                                          |
| `priority`              | `priority` (string: `urgent/high/medium/low/none`)       | map to int to match Linear semantics: `urgent→1, high→2, medium→3, low→4, none→null` (pick a mapping and document it; orchestrator only compares, doesn't math it) |
| `state`                 | resolve `state` UUID → state **name** via `/states/` map | **name**, not UUID (orchestrator compares against `active_states`/`terminal_states` names)                                                                         |
| `branchName`            | —                                                        | Plane has none. Synthesize: `${identifier.toLowerCase()}-${slug(title)}` or `null`. Match how AgentRunner consumes it.                                             |
| `url`                   | construct                                                | `${PLANE_ENDPOINT}/{WORKSPACE_SLUG}/projects/{PROJECT_ID}/issues/{id}`                                                                                             |
| `labels`                | `labels` (UUIDs) → names via `/labels/` map              | **lowercase**, filter empty (matches Linear adapter behavior)                                                                                                      |
| `blockedBy`             | n/a (see §2 caveat)                                      | `[]` with a `// LIMITATION:` comment                                                                                                                               |
| `createdAt`             | `created_at`                                             | ISO string or `null`                                                                                                                                               |
| `updatedAt`             | `updated_at`                                             | ISO string or `null`                                                                                                                                               |

`WorkflowStateInfo` (from `BoardReader.listWorkflowStates()`):

| `WorkflowStateInfo` field | Plane state field                                                             |
| ------------------------- | ----------------------------------------------------------------------------- |
| `id`                      | `id`                                                                          |
| `name`                    | `name`                                                                        |
| `type`                    | `group` (already uses backlog/unstarted/started/completed/cancelled — direct) |
| `position`                | `sequence`                                                                    |
| `color`                   | `color`                                                                       |

`IssueStateRef` (from `fetchIssueStatesByIds`): `{ id, identifier, state(name) }` — same
normalization, minimal projection.

> **Efficiency note:** state-name and label-name resolution needs the `/states/` and
> `/labels/` lists. Fetch them once per adapter operation batch and cache for the call (Linear
> got names inline via GraphQL; Plane returns UUIDs, so you must join client-side).

---

## 6. Implementation plan (phased)

Follow `elixir/`-style discipline if mirrored in TS: keep changes scoped, add tests, keep the
`Tracker` contract stable. Track progress in `TODO.md`.

### Phase 0 — Provision + smoke test (§3, §4)

Stand up Plane, create token, **record real API field names**. Reconcile §4/§5 against reality
before writing code. Output: a short note of any field-name deltas.

### Phase 1 — Config schema (Layer C)

`packages/core/src/config/schema.ts`:

- Add Plane fields to `trackerSchema` (keep it permissive — `kind` is already `z.string()`):
  `workspace_slug?`, `project_id?` (Plane needs both; Linear used `project_slug`). Keep
  `endpoint` but **change the default handling**: when `kind === 'plane'`, default endpoint to
  the local instance (or require it). Do **not** force the Linear default on Plane.
- Keep `DEFAULT_ACTIVE_STATES` / `DEFAULT_TERMINAL_STATES` (names already match the §3 states).

`packages/core/src/config/resolve.ts`:

- Generalize the API-key env fallback: resolve `tracker.api_key` from `$VAR`, else
  `PLANE_API_KEY` (keep `LINEAR_API_KEY` working if `kind === 'linear'`). Cleanest: fall back
  to a per-kind env name.

`packages/core/src/config/validate.ts`:

- Add a `plane` branch requiring `api_key`, `endpoint`, `workspace_slug`, `project_id`.

### Phase 2 — Plane REST client (Layer A transport)

New: `packages/tracker/src/plane/client.ts`, mirroring `linear/client.ts`:

- `PlaneClient` with `{ endpoint, apiKey, workspaceSlug, projectId }`.
- Generic `request(method, path, body?)` adding `X-API-Key`, JSON headers, 30s timeout,
  retry on 429/5xx with backoff (copy the Linear client's retry shape).
- Cursor-pagination helper `getAllPages(path, query)`.
- Inject transport for tests (same pattern as Linear's `Transport`).

### Phase 3 — PlaneTracker adapter (Layer A)

New: `packages/tracker/src/plane/adapter.ts` + `normalize.ts`. Implement **the same interfaces
the Linear adapter does** so the orchestrator is untouched:
`implements Tracker, IssueCreator, BoardReader, IssueWriter`, `readonly kind = 'plane'`.

Methods (signatures fixed by `tracker.ts` — do not change them):

- `fetchCandidateIssues()` → list issues, filter to `activeStates` (by state **name**), normalize.
- `fetchIssuesByStates(states)` → list issues filtered to given names.
- `fetchIssueStatesByIds(ids)` → `GET /issues/{id}/` per id (or batch if supported), project to `IssueStateRef`.
- `fetchAllIssues()` → all issues (board view).
- `listWorkflowStates()` → `GET /states/` → `WorkflowStateInfo[]` (group→type).
- `updateIssueState(issueId, stateId)` → `PATCH /issues/{issueId}/ { state: stateId }`.
- `addComment(issueId, body)` → `POST .../comments/ { comment_html }`.
- `uploadFile(input)` → Plane attachment upload flow → `{ assetUrl }`.
- `attachToIssue(issueId, url, title?)` → link asset (or post a comment with the link if no native attach-by-url).
- `createIssue(input)` → `POST /issues/`, then normalize the response.

Build `normalize.ts` per §5. Cache `/states/` and `/labels/` lookups within the client.

> Use `packages/tracker/src/memory/memory-tracker.ts` as the structural template — it
> implements the exact same interface set and shows the expected return/copy semantics
> (return shallow copies; throw early on API errors).

### Phase 4 — Agent-facing REST tool (Layer B) — **the critical refactor**

The agent currently runs raw Linear GraphQL via `linear_graphql`. Plane is REST, so:

1. **New executor** `packages/tracker/src/tools/plane-rest.ts`:
   `makePlaneRestExecutor(client)` exposing a single tool. Recommended tool shape — a thin,
   safe REST passthrough scoped to the configured project:
   ```ts
   // tool name: tracker_api  (rename away from linear_graphql)
   // input:
   {
     method: 'GET' | 'POST' | 'PATCH',     // no DELETE
     path: string,                         // relative to the project base; validated to stay within /workspaces/{slug}/projects/{id}/
     body?: Record<string, unknown>
   }
   // output: { success: boolean, output: string /* JSON */ }
   ```
   Validate `path` to prevent the agent escaping the configured workspace/project (reuse the
   spirit of the old `validateArgs`). Return the same `{success, output}` contract so callers
   don't change.
2. **Stdio MCP server** `packages/tracker/src/tools/stdio-tracker-server.ts` (replaces
   `stdio-linear-server.ts`): register tool `tracker_api`, read `PLANE_API_KEY`,
   `PLANE_ENDPOINT`, `PLANE_WORKSPACE_SLUG`, `PLANE_PROJECT_ID` from env.
   Update `packages/tracker/package.json` export map (`./stdio-linear-server` →
   `./stdio-tracker-server`) and `tsup.config.ts` entry.
3. **SDK MCP server** `packages/agent-backends/src/mcp/sdk-tracker-tool.ts` (replaces
   `sdk-linear-tool.ts`): `buildTrackerSdkMcpServer(executor)`, tool `tracker_api`, description
   updated. Update `packages/agent-backends/src/index.ts` exports.

> **Naming:** rename the tool `linear_graphql` → `tracker_api`. The MCP tool id the agent sees
> in the prompt (`mcp__symphony__linear_graphql`) **must change to `mcp__symphony__tracker_api`
> in the prompt too** (Phase 5). If you prefer minimal prompt churn you may keep the id, but a
> rename is clearer and prevents the agent from emitting GraphQL out of habit.

### Phase 5 — Rewrite `WORKFLOW.md` prompt (Layer B) — **must-not-miss**

Both `WORKFLOW.md` and `WORKFLOW.md.example` embed the agent prompt with **3 hardcoded Linear
GraphQL operations** (resolve state id → `issueUpdate` → `commentCreate`). Replace that block
with Plane REST instructions. Example replacement:

```markdown
You have a `mcp__symphony__tracker_api` tool that runs ONE REST call against the Plane project
with Symphony's configured auth. Paths are relative to this project; you cannot leave it.
Plane moves an issue by setting its **state UUID**, so resolve the id first:

a. List this project's workflow states and find the one named "Human Review":
{ "method": "GET", "path": "/states/" }
→ find the entry whose `name` == "Human Review"; take its `id`.
b. Move this issue to that state:
{ "method": "PATCH", "path": "/issues/{{ issue.id }}/", "body": { "state": "<STATE_UUID>" } }
c. Post your summary as a comment:
{ "method": "POST", "path": "/issues/{{ issue.id }}/comments/", "body": { "comment_html": "<p>…</p>" } }

Call the tool once per operation.
```

- Update front-matter `tracker:` block (see §7).
- Replace every Linear-state-name reference only if you changed names in §3 (we kept them, so
  `Human Review`, `Todo`, etc. stay valid).

### Phase 6 — Runtime dispatch (Layer B wiring)

`packages/core/src/runtime.ts`:

- `buildTracker()`: add `if (t.kind === 'plane') return new PlaneTracker({...})` (endpoint,
  apiKey, workspaceSlug, projectId, activeStates). Keep `memory` and (optionally) `linear`.
- `buildMcpConfig()`: branch on `kind === 'plane'`:
  - `claude-sdk` backend → `new PlaneClient(...)` + `makePlaneRestExecutor` + `buildTrackerSdkMcpServer`.
  - CLI backends → stdio spec pointing at `stdio-tracker-server`, env `PLANE_API_KEY` /
    `PLANE_ENDPOINT` / `PLANE_WORKSPACE_SLUG` / `PLANE_PROJECT_ID`.

### Phase 7 — Docs

- `README.md`: replace Linear-Cloud setup with Plane self-host quick start + `PLANE_API_KEY`.
- `docs/RUNBOOK.md`: Plane deploy, token, state config, the `blockedBy` limitation, REST
  troubleshooting (401 = bad `X-API-Key`, 404 = wrong workspace/project).
- `CLAUDE.md`: update architecture notes (`LinearTracker`→`PlaneTracker`, `linear_graphql`→`tracker_api`, orchestrator still read-only).
- `WORKFLOW.md.example`: the canonical template (done in Phase 5).
- `SPEC.md`/root `README.md` if they assert "Linear" as the tracker — keep contract truthful.

### Phase 8 — Tests

- New: `packages/tracker/src/plane/{adapter,client,normalize}.test.ts` mirroring the Linear
  tests (inject fake transport; assert normalization, pagination, state filtering).
- New: `packages/tracker/src/tools/plane-rest.test.ts` + `stdio-tracker-server.test.ts`
  (path-confinement validation, error passthrough).
- `packages/core/src/config/resolve.test.ts`: add Plane env-resolution cases.
- Orchestrator tests already use `MemoryTracker` — they should stay green untouched (proof the
  contract didn't move). Run the full suite + coverage gate.

---

## 7. `WORKFLOW.md` front-matter — before/after

```diff
 tracker:
-  kind: linear
-  endpoint: https://api.linear.app/graphql
-  api_key: $LINEAR_API_KEY
-  project_slug: 'REPLACE_ME'
+  kind: plane
+  endpoint: http://10.0.0.x          # local Plane instance
+  api_key: $PLANE_API_KEY
+  workspace_slug: 'REPLACE_ME'
+  project_id: 'REPLACE_ME_UUID'
   active_states: [Todo, In Progress, Rework, Merging]
   terminal_states: [Done, Canceled]
```

---

## 8. Full blast-radius checklist (file-by-file)

**Create**

- `packages/tracker/src/plane/client.ts`
- `packages/tracker/src/plane/adapter.ts`
- `packages/tracker/src/plane/normalize.ts`
- `packages/tracker/src/plane/{adapter,client,normalize}.test.ts`
- `packages/tracker/src/tools/plane-rest.ts` (+ test)
- `packages/tracker/src/tools/stdio-tracker-server.ts` (+ test)
- `packages/agent-backends/src/mcp/sdk-tracker-tool.ts`

**Edit**

- `packages/core/src/runtime.ts` — `buildTracker`, `buildMcpConfig`
- `packages/core/src/config/schema.ts` — Plane fields + endpoint default
- `packages/core/src/config/resolve.ts` — `PLANE_API_KEY` fallback
- `packages/core/src/config/validate.ts` — plane branch
- `packages/tracker/src/index.ts` — export `PlaneTracker`, `PlaneClient`, `makePlaneRestExecutor`, `buildStdioTrackerServer`
- `packages/tracker/package.json` — export map (`./stdio-tracker-server`)
- `packages/tracker/tsup.config.ts` — stdio entry
- `packages/agent-backends/src/index.ts` — export `buildTrackerSdkMcpServer`
- `WORKFLOW.md`, `WORKFLOW.md.example` — front-matter + prompt body
- `README.md`, `docs/RUNBOOK.md`, `CLAUDE.md`, `TODO.md`

**Keep unchanged (contract / neutral)**

- `packages/shared/src/issue.ts` — `NormalizedIssue` etc.
- `packages/tracker/src/tracker.ts` — interfaces
- `packages/tracker/src/memory/memory-tracker.ts` — test double
- `packages/core/src/orchestrator/*` — no changes (proves the abstraction held)

**Decommission (decide per §12)**

- `packages/tracker/src/linear/*`, `tools/linear-graphql.ts`, `tools/stdio-linear-server.ts`,
  `agent-backends/src/mcp/sdk-linear-tool.ts`. Either delete, or keep `kind: 'linear'` working
  alongside `plane` (recommended: keep — the abstraction supports both, and it de-risks
  rollback).

---

## 9. Acceptance criteria

1. `tracker.kind: plane` boots the orchestrator against a local Plane instance with **no
   network calls to `linear.app`** (grep the codebase; assert no `linear.app` at runtime).
2. Orchestrator polls Plane, dispatches issues in `active_states`, and stops/cleans up on
   `terminal_states`.
3. The agent can, via `tracker_api`: list states, move the issue to `Human Review`, and post a
   comment — end-to-end on a real Plane ticket.
4. `MemoryTracker`-based orchestrator tests still pass unchanged.
5. New Plane adapter/tool tests pass; coverage gate met.
6. Docs describe Plane setup; the `blockedBy` limitation is documented.

---

## 10. Risks & gotchas

- **Plane API drift.** Field names (`description_html` vs `description_stripped`,
  attachment route) vary by version — Phase 0 smoke test is mandatory; treat §4/§5 as expected,
  not gospel.
- **State name vs UUID.** Orchestrator compares **names**; Plane mutates by **UUID**. The
  adapter joins via `/states/`; the agent prompt resolves the UUID at run time. Cache the
  state list to avoid an extra call per issue.
- **`blockedBy` is empty** under Plane (§2). Don't let any orchestrator logic silently rely on
  it — verify dispatch behavior when `blockedBy: []`.
- **Path confinement in `tracker_api`.** A raw REST passthrough is powerful; validate `path`
  so the agent can't hit other projects/workspaces or non-issue admin routes.
- **Priority mapping** (string↔int) is a convention you introduce — keep it consistent across
  adapter + any UI/dashboard that displays priority.
- **Identifier construction** needs the project identifier prefix; fetch once and cache.

---

## 11. Suggested commit/branch structure

Branch `feat/plane-tracker`. Commits by phase: `config schema`, `plane client+adapter`,
`plane rest tool + mcp`, `workflow prompt rewrite`, `runtime dispatch`, `docs`, `tests`.
Do not auto-commit/push without the user's say-so.

---

## 12. Open questions (resolve before/within implementation)

1. **Keep `kind: linear` or delete it?** Recommendation: **keep** for rollback safety; the
   abstraction supports both. Confirm.
2. **Blocking relations** — is `blockedBy` actually used by orchestrator dispatch logic in a
   way that matters for this user's flow? If yes and the Plane `[]` default is unacceptable,
   switch to **OpenProject** (fallback) or implement Plane's internal relation endpoint.
3. **`tracker_api` shape** — generic REST passthrough (proposed) vs a small set of explicit
   tools (`move_issue`, `add_comment`)? Passthrough is flexible but needs strict path
   validation; explicit tools are safer but less flexible. Confirm preference.
4. **Tool rename** — `linear_graphql` → `tracker_api` (recommended) or keep the old id to
   minimize prompt churn? Confirm.
5. **Plane endpoint/host** — confirm the actual local URL and whether it'll run on the
   existing homelab (Proxmox/Swarm) or a new box.
