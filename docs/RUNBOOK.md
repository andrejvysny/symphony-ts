# Symphony-TS — First Live Run Runbook (commit-only mode)

A step-by-step guide to running Symphony-TS end-to-end against the **local file-store tracker** and a
**local Claude Code** agent, in **commit-only mode**: the agent implements a ticket in an isolated git
worktree, **commits locally** (no push / no PR), then moves the ticket to a parked state for a human.
Nothing leaves your machine — there is no database and no external service. This is the safest first
validation; pushing + PRs come later.

## What happens

```
poll the file store → pick a Todo/active ticket → create git worktree off your local repo
  → run Claude Code (claude-sdk) in that worktree until it commits + moves the ticket
  → ticket lands in "Human Review" (non-active) → orchestrator releases it, KEEPS the worktree
```

## The tracker is just files on disk

There is no tracker server. State lives under a single root, `~/.symphony` by default (override with
`tracker.data_root` in `WORKFLOW.md`). Each project is a directory under `projects/<projectKey>/`:

```
~/.symphony/
├── tracker.sock                     # internal bridge socket (CLI backends connect here)
└── projects/
    └── default/                     # <projectKey> = tracker.project_id (a slug)
        ├── meta.json                # { identifier, next_seq } — source of truth for issue ids
        ├── states.json              # workflow states (seeded from config on first use)
        ├── labels.json
        ├── issues/
        │   ├── DEF-1.json           # one StoredIssue per ticket
        │   └── DEF-1/
        │       ├── comments.jsonl   # one comment per line
        │       └── activity.jsonl   # one activity entry per line
        └── uploads/<uuid>/<file>    # attachment bytes
```

Workflow states come from config (`active_states` / `review_state` / `terminal_states`) and are
**seeded into `states.json` on first use** — there is no external board to set up. Seeding is
idempotent and never clobbers edits you make to `states.json` afterward.

## Prerequisites

- **Node ≥ 22** and **pnpm**. No external services — the tracker is plain files.
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

## 2. Configure `WORKFLOW.md`

Copy the annotated example and edit it:

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

- `tracker.kind` → `file` (the only supported tracker).
- `tracker.data_root` → leave as `~/.symphony` (or point elsewhere; the store is created on demand).
- `tracker.project_id` → the active project key, a slug naming its directory under
  `<data_root>/projects/`. Defaults to `default`.
- `tracker.active_states` / `review_state` / `terminal_states` → state **names** (case-sensitive). The
  agent may set `active_states` + `review_state`, never a terminal state. These names are seeded into
  the project's `states.json`, so a typo just creates a state nothing dispatches into. Defaults:
  active `[Todo, In Progress, Rework, Merging]`, review `Human Review`, terminal `[Done, Cancelled]`.
- `workspace.repo` → absolute path to your disposable local repo (a real git repo with ≥1 commit).

First-run-safe agent knobs are already set in the example: `backend: claude-sdk`,
`permission_mode: bypassPermissions`, `max_concurrent_agents` low, `max_turns` low,
`max_continuations` low, plus an optional `max_budget_usd`. `claude-sdk` emits only at message
boundaries, so a long tool call (like `npm ci`) can look idle; `turn_timeout_ms` is **not** honored by
`claude-sdk`, so the budget cap and `stall_timeout_ms` are your real bounds. Keep `max_concurrent_agents: 1`
for the first run.

If your global git identity is unset, add it to the `after_create` hook:

```yaml
hooks:
  after_create: |
    git config user.email "you@example.com"
    git config user.name  "You"
    if [ -f package.json ]; then npm ci || npm install; fi
```

## 3. Seed a test ticket

Use the dashboard's **+ New ticket** button (once running, step 5), or the CLI — which just writes a
JSON file under the store:

```bash
node apps/cli/dist/main.js ticket create "Add a HELLO.md file" --state Todo \
  --desc "Create HELLO.md containing the word hello. Keep it trivial."
# or, if `symphony` is on PATH:
symphony ticket create "Add a HELLO.md file" --state Todo --desc "..."
```

Flags: `--desc <text>`, `--state <name>`, `--priority <n>`. The command prints the new identifier
(e.g. `created DEF-1 (DEF-1)`). Keep the first task trivial — you are validating the loop, not the
agent's skill.

## 4. Run + watch

```bash
node apps/cli/dist/main.js ./WORKFLOW.md --port 4500
# or: symphony ./WORKFLOW.md --port 4500
```

- Symphony dashboard: <http://127.0.0.1:4500/> (refined-Kanban board + Agents view, ticket modal,
  per-agent detail drawer with live agent-event log via SSE, header **project switcher**, and a
  **Settings** panel).
- Logs stream to the terminal (pretty by default; `--json-logs` for structured).
- JSON API (read): `GET /api/v1/state`, `GET /api/v1/meta` (run constants: capacity, caps, backend),
  `GET /api/v1/capabilities`, `GET /api/v1/board`, `GET /api/v1/states`, `GET /api/v1/labels`,
  `GET /api/v1/sessions` (enriched: backend, last_action, continuation_count),
  `GET /api/v1/:issueIdentifier`, plus `GET /api/v1/issues/:id/detail` and
  `GET /api/v1/sessions/:issueId/logs` (SSE).
- Issue edits (ticket modal): `PATCH /api/v1/issues/:id/state` (move) and
  `PATCH /api/v1/issues/:id` (title/description/priority/labels), `POST /api/v1/tickets` (create),
  `POST /api/v1/issues/:id/comments`.
- Projects (switcher): `GET /api/v1/projects`, `POST /api/v1/projects` (create a new file-store
  project dir + register it), `POST /api/v1/projects/switch` (live re-point — terminates running
  agents, swaps tracker+repo, resets, resumes; no restart). Registry lives in `WORKFLOW.md`
  `projects:` (each entry `{name, project_id, repo, identifier}`).
- Settings (panel): `GET /api/v1/settings`, `PATCH /api/v1/settings` (agent/polling/branch_prefix;
  persisted to `WORKFLOW.md` front matter and applied live).
- Sessions control: `POST /api/v1/sessions/terminate-all`, `POST /api/v1/sessions/:issueId/terminate`,
  `POST /api/v1/sessions/:issueId/unblock`, `POST /api/v1/refresh`.
- Stop with Ctrl-C (graceful shutdown).

## 5. Expected behavior

1. Within `polling.interval_ms`, the Todo ticket is dispatched (dashboard shows it **running**).
2. A worktree appears at `<workspace.root>/<IDENTIFIER>` (shared clone at `<root>/.repo`).
3. Claude Code works in the worktree, commits to branch `symphony/<IDENTIFIER>`, and uses the
   semantic tracker tools (`tracker_get_task` / `tracker_update_status` / `tracker_add_comment`) to
   move the ticket to **Human Review** + post an evidence comment. (The agent never writes raw files;
   for CLI backends those tool calls are proxied to the orchestrator over the internal Unix-socket
   bridge at `~/.symphony/tracker.sock`, so the orchestrator is the single writer — this is automatic.)
4. The worker's post-turn state check sees a non-active state → **releases** the issue, **preserves**
   the worktree (orchestrator logs `stopped: non-active state`).

## 6. Verify results

```bash
cd <workspace.root>/<IDENTIFIER>
git log --oneline -3 && git status
# inspect the ticket's on-disk state directly:
cat ~/.symphony/projects/default/issues/<IDENTIFIER>.json
cat ~/.symphony/projects/default/issues/<IDENTIFIER>/comments.jsonl
```

- The ticket JSON should show state **Human Review**, and `comments.jsonl` should hold the agent's
  summary comment.
- The branch `symphony/<IDENTIFIER>` holds the commit (local only — not pushed).

## 7. Review the result (dashboard)

Open a **Human Review** ticket on the board to get a review panel in the side rail:

- **Accept** — moves the ticket to the terminal Done state. The orchestrator then cleans up the
  worktree/branch on its next reconcile.
- **Discard** — moves it to Cancelled (also terminal → cleaned up).
- **Rework** — posts the **Notes** textarea (if filled) as a comment and sends the ticket back to the
  active **Rework** state. The agent re-runs and sees the note via `tracker_get_task`.
- **Open in VS Code** — a link in the side rail (`vscode://file…`) that opens the issue's worktree
  folder. Shown only when the worktree still exists on disk.

The **Backlog** lane (leftmost) holds tickets that aren't ready yet — the orchestrator never
dispatches them. Drag a ticket to **Todo** when it's ready to be worked. The agent drawer (Agents
tab → a running agent) can be **dragged wider** from its left edge (double-click the edge to reset).

## Troubleshooting / known gotchas

| Symptom                            | Likely cause                                           | Fix                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing dispatches                 | `active_states` names don't match the ticket's state   | Match state names exactly (case-sensitive); inspect the ticket with `cat ~/.symphony/projects/<projectKey>/issues/<ID>.json` and confirm its `state` is one of `active_states`        |
| Agent binary not found / skipped   | the configured `agent.backend` CLI isn't on `PATH`     | Install/login the CLI (`claude`, `codex`, or `opencode`); detection runs once at startup and a missing binary skips dispatch with a reason rather than an opaque exit-127             |
| Worktree clone error               | `workspace.repo` path wrong or not a git repo          | Point at a real local repo with ≥1 commit                                                                                                                                             |
| Stale shared clone                 | a previous run left a corrupt `<workspace.root>/.repo` | Remove `<workspace.root>/.repo`; it is re-cloned on the next run                                                                                                                      |
| Agent can't move the ticket        | tracker tools not reached                              | Tracker tools wire for `claude-sdk` (in-process) and the CLI backends (stdio MCP, proxied over `~/.symphony/tracker.sock`). Confirm the socket exists and the backend started cleanly |
| Ticket never leaves active         | status name not settable                               | `tracker_update_status` resolves the name → state and only accepts `active_states` + `review_state` names (never terminal); ensure those config names match the seeded states         |
| `git commit` fails ("who are you") | worktree has no git identity                           | Set global `git config user.*` or use the `after_create` snippet                                                                                                                      |
| Runaway turns / cost               | agent never reaches a terminal/parked state            | `max_continuations` (→ blocked) and `max_budget_usd` cap it; a retryable failure backs off up to `agent.max_failure_retries`, then blocks                                             |
| Turn looks stuck / silent          | a long tool call with no events                        | The in-backend idle watchdog (`agent.idle_timeout_ms`) kills a truly silent turn; the coarser `stall_timeout_ms` is the orchestrator-side bound                                       |

## Limitations (file tracker)

- **`blockedBy` is always empty.** The file store does not model issue relations, so the
  orchestrator's "skip a Todo blocked by a non-terminal issue" auto-skip is **disabled**. Manage
  blocking by keeping blocked issues out of `active_states`.
- **Priority is an int Symphony only sorts by** (`urgent→1 … none→null`); it does not gate dispatch.
- **`branchName` is synthesized.** The worker derives branches from the identifier
  (`symphony/<IDENTIFIER>`).

## Safety notes

- `permission_mode: bypassPermissions` grants the agent **full autonomy** in the worktree. Use a
  **disposable** repo for the first runs.
- Commits stay **local**; nothing is pushed. The whole pipeline (tracker + agent) runs on your machine.
- `max_budget_usd` is the hard spend cap per turn for `claude-sdk`.

## tmux supervision (CLI backends only)

With `agent.tmux: true`, each turn of a CLI backend (`claude-cli` / `codex-cli` / `opencode-cli`) runs
inside a tmux session you can attach to live:

```bash
tmux attach -t symphony-<IDENTIFIER>
```

Raw stdout is `tee`'d to `logs_root` (`run.jsonl` / `err.log` per turn; default `<tmpdir>/symphony_logs`,
override with `--logs-root`). This has **no effect** on the in-process `claude-sdk` backend.

## Multi-project

Each project is a repo plus its own store directory under `~/.symphony/projects/`. Registered projects
live in `WORKFLOW.md` `projects:` (each `{name, project_id, repo, identifier}`). Use the dashboard's
header **project switcher** to switch live (`POST /api/v1/projects/switch`): it terminates running
agents, atomically swaps the tracker + repo scope, and resumes — no restart. Sessions do not carry
across projects.

## Reset between runs

Workspaces are preserved on purpose. For a clean re-run of the **same** ticket:

```bash
git -C <workspace.root>/.repo worktree remove --force <workspace.root>/<IDENTIFIER>
git -C <workspace.root>/.repo branch -D symphony/<IDENTIFIER>   # optional
```

Then move the ticket back to **Todo** (dashboard, or edit its `issues/<ID>.json` state). Simplest of
all: just create a fresh ticket each run. To wipe a project's tracker state entirely, delete its
directory under the store: `rm -rf ~/.symphony/projects/<projectKey>` (it is re-seeded on next use).
