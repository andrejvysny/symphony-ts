# Symphony-TS — First Live Run Runbook (commit-only mode)

A step-by-step guide to running Symphony-TS end-to-end against a **real Linear project** and a
**local Claude Code** agent, in **commit-only mode**: the agent implements a ticket in an isolated
git worktree, **commits locally** (no push / no PR), then moves the ticket to a parked state for a
human. This is the safest first validation; pushing + PRs come later.

## What happens

```
poll Linear → pick a Todo/active ticket → create git worktree off your local repo
  → run Claude Code (claude-sdk) in that worktree until it commits + moves the ticket
  → ticket lands in "Human Review" (non-active) → orchestrator releases it, KEEPS the worktree
```

## Prerequisites

- **Node ≥ 22** and **pnpm**.
- **Claude logged in on this host** (`~/.claude`) — the `claude-sdk` backend reuses your host login;
  no API key is injected. Verify with `claude` (the CLI) working interactively.
- **Git identity set globally**: `git config --global user.name` and `...user.email` must return
  values. The worktree is a fresh clone and does **not** inherit a repo-local identity, so the
  agent's `git commit` relies on your global config (or the `after_create` hook below).
- A **Linear API key**: Linear → Settings → Security & access → personal API key
  (`export LINEAR_API_KEY=lin_api_...`).
- A **disposable local git repo** to act as `workspace.repo` (worktrees branch off it; commits stay
  local). Create one if needed:
  ```bash
  mkdir -p ~/tmp/symphony-playground && cd ~/tmp/symphony-playground
  git init -b main && echo "# playground" > README.md && git add . && git commit -m init
  ```

## 1. Build

```bash
cd symphony-ts
pnpm install && pnpm build
```

## 2. Linear setup

- Create (or pick) a Linear **project**; copy its slug: right-click the project → Copy URL → the slug
  is the trailing segment.
- Note your team's **workflow state names exactly** (case-sensitive). For the Symphony custom flow,
  add `Rework`, `Human Review`, `Merging` in Team Settings → Workflow. "Human Review" is the
  commit-only stop: it must **not** be in `active_states`.

## 3. Configure `WORKFLOW.md`

A gitignored `WORKFLOW.md` already exists (copied from `WORKFLOW.md.example`). Edit the two
`REPLACE_ME` values and confirm the state names:

- `tracker.project_slug` → your project slug.
- `workspace.repo` → absolute path to your disposable local repo (e.g. `/Users/you/tmp/symphony-playground`).
- `tracker.active_states` / `terminal_states` → must match your Linear board **exactly**. A mismatch
  silently dispatches nothing.

First-run-safe knobs are already set: `backend: claude-sdk`, `permission_mode: bypassPermissions`,
`max_concurrent_agents: 1`, `max_turns: 6`, `max_continuations: 2`, `max_budget_usd: 2`,
`stall_timeout_ms: 900000` (15m — `claude-sdk` emits only at message boundaries, so a long tool call
like `npm ci` can look idle; `turn_timeout_ms` is **not** honored by `claude-sdk`, so the budget cap
and stall timeout are your real bounds).

If your global git identity is unset, add it to the `after_create` hook instead:

```yaml
hooks:
  after_create: |
    git config user.email "you@example.com"
    git config user.name  "You"
    if [ -f package.json ]; then npm ci || npm install; fi
```

## 4. Seed a test ticket

Either create a ticket in the Linear UI (state **Todo**, a small scoped task), or via the CLI:

```bash
export LINEAR_API_KEY=lin_api_...
node apps/cli/dist/main.js ticket create "Add a HELLO.md file" --state Todo \
  --desc "Create HELLO.md containing the word hello. Keep it trivial."
```

Keep the first task trivial — you are validating the loop, not the agent's skill.

## 5. Run + watch

```bash
export LINEAR_API_KEY=lin_api_...
node apps/cli/dist/main.js ./WORKFLOW.md --port 4500
```

- Dashboard: <http://127.0.0.1:4500/> (board, running sessions, live agent-event log via SSE).
- Logs stream to the terminal (pretty by default; `--json-logs` for structured).
- JSON API: `GET /api/v1/state`, `GET /api/v1/:issueIdentifier`, `POST /api/v1/refresh`.
- Stop with Ctrl-C (graceful shutdown).

## 6. Expected behavior

1. Within `polling.interval_ms`, the Todo ticket is dispatched (dashboard shows it **running**).
2. A worktree appears at `<workspace.root>/<IDENTIFIER>` (shared clone at `<root>/.repo`).
3. Claude Code works in the worktree, commits to branch `symphony/<IDENTIFIER>`, and calls
   `mcp__symphony__linear_graphql` to move the ticket to **Human Review** + post a comment.
4. The worker's post-turn state check sees a non-active state → **releases** the issue, **preserves**
   the worktree. The dashboard shows it leave "running" with no retry.

## 7. Verify results

```bash
# Inspect the agent's commit (worktree is preserved):
cd <workspace.root>/<IDENTIFIER>
git log --oneline -3
git status
```

- The Linear ticket should be in **Human Review** with the agent's summary comment.
- The branch `symphony/<IDENTIFIER>` holds the commit (local only — not pushed).

## Troubleshooting / known gotchas

| Symptom                                              | Likely cause                                                       | Fix                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing dispatches                                   | `active_states`/`project_slug` don't match Linear (case-sensitive) | Match state names exactly; verify slug                                                                                                                                            |
| `tracker.api_key required` at start                  | `LINEAR_API_KEY` unset / empty                                     | `export LINEAR_API_KEY=...` before running                                                                                                                                        |
| Worktree clone/worktree error                        | `workspace.repo` path wrong or not a git repo                      | Point at a real local repo with ≥1 commit                                                                                                                                         |
| Agent can't move the ticket                          | MCP tool not reached                                               | Prompt names `mcp__symphony__linear_graphql`; works for `claude-sdk` (in-process) and `claude-cli` (stdio MCP via `--mcp-config`). `codex-cli`/`opencode-cli` do not wire MCP yet |
| Ticket never leaves active / `stateId` GraphQL error | `issueUpdate` needs the workflow-state **UUID**, not its name      | The prompt resolves it (`query … team { states { nodes { id name } } }` → `issueUpdate(input:{stateId})`); keep that two-step recipe if you customize the prompt                  |
| `git commit` fails ("who are you")                   | worktree has no git identity                                       | Set global `git config user.*` or use the `after_create` snippet above                                                                                                            |
| Worker aborts mid-task                               | stall timeout hit during a long silent tool call                   | Raise `stall_timeout_ms`                                                                                                                                                          |
| Runaway turns / cost                                 | agent never reaches a terminal/parked state                        | `max_continuations` (→ blocked) and `max_budget_usd` cap it; lower them                                                                                                           |
| Agent asks for input                                 | non-interactive → surfaced as **blocked**                          | Unblock by editing the ticket and moving it back to active                                                                                                                        |

## Safety notes

- `permission_mode: bypassPermissions` grants the agent **full autonomy** in the worktree. Use a
  **disposable** repo for the first runs.
- Commits stay **local**; nothing is pushed. Pushing + PRs are intentionally deferred.
- `max_budget_usd` is the hard spend cap per turn for `claude-sdk`.

## Reset between runs

Workspaces are preserved on purpose. For a clean re-run of the **same** ticket:

```bash
git -C <workspace.root>/.repo worktree remove --force <workspace.root>/<IDENTIFIER>
git -C <workspace.root>/.repo branch -D symphony/<IDENTIFIER>   # optional
```

Then move the ticket back to **Todo**. Simplest of all: just create a fresh ticket each run.
