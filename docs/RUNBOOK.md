# Symphony-TS — First Live Run Runbook (commit-only mode)

A step-by-step guide to running Symphony-TS end-to-end against a **local self-hosted Plane** instance
and a **local Claude Code** agent, in **commit-only mode**: the agent implements a ticket in an
isolated git worktree, **commits locally** (no push / no PR), then moves the ticket to a parked state
for a human. Nothing leaves your machine. This is the safest first validation; pushing + PRs come later.

## What happens

```
poll Plane → pick a Todo/active ticket → create git worktree off your local repo
  → run Claude Code (claude-sdk) in that worktree until it commits + moves the ticket
  → ticket lands in "Human Review" (non-active) → orchestrator releases it, KEEPS the worktree
```

## Prerequisites

- **Node ≥ 22** and **pnpm**, plus **Docker** (Docker Desktop or compatible) for the local Plane stack.
- **Claude logged in on this host** (`~/.claude`) — the `claude-sdk` backend reuses your host login;
  no API key is injected. Verify with the `claude` CLI working interactively.
- **Git identity set globally**: `git config --global user.name` / `...user.email` must return values
  (the worktree is a fresh clone and does not inherit a repo-local identity), or set them in the
  `after_create` hook below.
- A **disposable local git repo** for `workspace.repo` (worktrees branch off it; commits stay local):
  ```bash
  mkdir -p ~/tmp/symphony-playground && cd ~/tmp/symphony-playground
  git init -b main && echo "# playground" > README.md && git add . && git commit -m init
  ```

## 1. Build

```bash
cd symphony-ts
pnpm install && pnpm build
```

## 2. Start local Plane

```bash
pnpm plane:up      # docker compose up -d (first run pulls ~10 images; give it a few minutes)
pnpm plane:ps      # wait until services are running; the API needs ~1 min to migrate + boot
```

Plane's UI + REST API are at **http://localhost** (see `infra/plane/README.md` to change the port).
In the UI:

1. Create the first admin account, then a **Workspace** and a **Project**.
2. Note the `workspace_slug` (from the URL `/<workspace-slug>/`) and the project **UUID** (project
   settings) + the project **identifier** prefix (e.g. `SYM`).
3. Configure the project's workflow states to match Symphony's flow — the state **group** is what
   matters. A new Plane project ships with `Backlog`/`Todo`/`In Progress`/`Done`/`Cancelled`; **add**
   `Rework`, `Merging`, and `Human Review` (all group **started**):

   | State                                | group     | Symphony role                                   |
   | ------------------------------------ | --------- | ----------------------------------------------- |
   | `Todo`                               | unstarted | active (dispatch)                               |
   | `In Progress` / `Rework` / `Merging` | started   | active                                          |
   | `Human Review`                       | started   | parked (agent moves here when it needs a human) |
   | `Done`                               | completed | terminal                                        |
   | `Cancelled`                          | cancelled | terminal                                        |

4. Create a **Personal Access Token** (Profile → Settings → API Tokens) and export it:
   `export PLANE_API_KEY=plane_api_...`.

## 3. Configure `WORKFLOW.md`

A gitignored `WORKFLOW.md` already exists (copied from `WORKFLOW.md.example`). Edit it:

- `tracker.endpoint` → `http://localhost` (your Plane instance).
- `tracker.workspace_slug` → your workspace slug.
- `tracker.project_id` → your project **UUID**.
- `tracker.api_key` → leave as `$PLANE_API_KEY` (read from the env).
- `tracker.active_states` / `terminal_states` → must match your Plane state **names exactly**
  (case-sensitive). A mismatch silently dispatches nothing. Defaults assume the table above
  (terminal `[Done, Cancelled]` — note Plane's default is "Cancelled" with two l's).
- `workspace.repo` → absolute path to your disposable local repo.

First-run-safe agent knobs are already set: `backend: claude-sdk`, `permission_mode: bypassPermissions`,
`max_concurrent_agents: 1`, `max_turns: 6`, `max_continuations: 2`, `max_budget_usd: 2`,
`stall_timeout_ms: 900000` (15m — `claude-sdk` emits only at message boundaries, so a long tool call
like `npm ci` can look idle; `turn_timeout_ms` is **not** honored by `claude-sdk`, so the budget cap
and stall timeout are your real bounds).

If your global git identity is unset, add it to the `after_create` hook:

```yaml
hooks:
  after_create: |
    git config user.email "you@example.com"
    git config user.name  "You"
    if [ -f package.json ]; then npm ci || npm install; fi
```

## 4. Seed a test ticket

Create a ticket in the Plane UI (state **Todo**, a small scoped task), or via the CLI:

```bash
export PLANE_API_KEY=plane_api_...
node apps/cli/dist/main.js ticket create "Add a HELLO.md file" --state Todo \
  --desc "Create HELLO.md containing the word hello. Keep it trivial."
```

Keep the first task trivial — you are validating the loop, not the agent's skill.

## 5. Run + watch

```bash
export PLANE_API_KEY=plane_api_...
node apps/cli/dist/main.js ./WORKFLOW.md --port 4500
```

- Symphony dashboard: <http://127.0.0.1:4500/> (refined-Kanban board + Agents view, ticket modal,
  per-agent detail drawer with live agent-event log via SSE).
- Logs stream to the terminal (pretty by default; `--json-logs` for structured).
- JSON API: `GET /api/v1/state`, `GET /api/v1/meta` (run constants: capacity, caps, backend),
  `GET /api/v1/board`, `GET /api/v1/sessions` (enriched: backend, last_action, continuation_count),
  `GET /api/v1/labels`, `GET /api/v1/:issueIdentifier`, `POST /api/v1/refresh`.
- Issue edits (ticket modal): `PATCH /api/v1/issues/:id/state` (move) and
  `PATCH /api/v1/issues/:id` (title/description/priority/labels; label names resolved to ids).
- Stop with Ctrl-C (graceful shutdown).

## 6. Expected behavior

1. Within `polling.interval_ms`, the Todo ticket is dispatched (dashboard shows it **running**).
2. A worktree appears at `<workspace.root>/<IDENTIFIER>` (shared clone at `<root>/.repo`).
3. Claude Code works in the worktree, commits to branch `symphony/<IDENTIFIER>`, and uses
   `mcp__symphony__tracker_api` to move the ticket to **Human Review** + post a comment.
4. The worker's post-turn state check sees a non-active state → **releases** the issue, **preserves**
   the worktree (orchestrator logs `stopped: non-active state`).

## 7. Verify results

```bash
cd <workspace.root>/<IDENTIFIER>
git log --oneline -3 && git status
```

- The Plane ticket should be in **Human Review** with the agent's summary comment.
- The branch `symphony/<IDENTIFIER>` holds the commit (local only — not pushed).

## Troubleshooting / known gotchas

| Symptom                                       | Likely cause                                                   | Fix                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing dispatches                            | `active_states`/state names don't match Plane (case-sensitive) | Match state names exactly; "Cancelled" is spelled with two l's by default                                                                                                      |
| `tracker.api_key required for plane` at start | `PLANE_API_KEY` unset / empty                                  | `export PLANE_API_KEY=plane_api_...` before running                                                                                                                            |
| `Plane HTTP 403`                              | bad / revoked `X-API-Key`                                      | Regenerate the Personal Access Token                                                                                                                                           |
| `Plane HTTP 404` on every call                | wrong `workspace_slug` or `project_id`                         | Re-copy the slug from the URL and the project UUID from settings                                                                                                               |
| Worktree clone error                          | `workspace.repo` path wrong or not a git repo                  | Point at a real local repo with ≥1 commit                                                                                                                                      |
| Agent can't move the ticket                   | MCP tool not reached                                           | Prompt names `mcp__symphony__tracker_api`; wired for `claude-sdk` (in-process) and `claude-cli` (stdio MCP via `--mcp-config`). `codex-cli`/`opencode-cli` do not wire MCP yet |
| Ticket never leaves active                    | Plane moves issues by state **UUID**, not name                 | The prompt resolves it (`GET /states/` → find "Human Review".id → `PATCH /work-items/{id}/ {state}`); keep that recipe if you customize the prompt                             |
| Blocked issues still dispatched               | `blockedBy` is always `[]` under Plane (see Limitations)       | Keep blocked issues out of `active_states`                                                                                                                                     |
| `git commit` fails ("who are you")            | worktree has no git identity                                   | Set global `git config user.*` or use the `after_create` snippet                                                                                                               |
| Runaway turns / cost                          | agent never reaches a terminal/parked state                    | `max_continuations` (→ blocked) and `max_budget_usd` cap it                                                                                                                    |

## Limitations (Plane)

- **`blockedBy` is always empty.** Plane's public `/api/v1/` does not expose issue relations, so the
  orchestrator's "skip a Todo blocked by a non-terminal issue" auto-skip is **disabled**. Manage
  blocking by keeping blocked issues out of `active_states`. (See the `// LIMITATION:` notes in
  `packages/tracker/src/plane/normalize.ts`.)
- **Priority is a convention.** Plane's string priority maps to an int Symphony only sorts by:
  `urgent→1, high→2, medium→3, low→4, none→null`.
- **`branchName` is synthesized.** Plane has none; the worker derives branches from the identifier
  (`symphony/<IDENTIFIER>`).

## Safety notes

- `permission_mode: bypassPermissions` grants the agent **full autonomy** in the worktree. Use a
  **disposable** repo for the first runs.
- Commits stay **local**; nothing is pushed. The whole pipeline (Plane + agent) runs on your machine.
- `max_budget_usd` is the hard spend cap per turn for `claude-sdk`.

## Reset between runs

Workspaces are preserved on purpose. For a clean re-run of the **same** ticket:

```bash
git -C <workspace.root>/.repo worktree remove --force <workspace.root>/<IDENTIFIER>
git -C <workspace.root>/.repo branch -D symphony/<IDENTIFIER>   # optional
```

Then move the ticket back to **Todo** in Plane. Simplest of all: just create a fresh ticket each run.
To wipe Plane entirely: `pnpm plane:down` then `docker volume rm` the `infra-plane_*` volumes.
