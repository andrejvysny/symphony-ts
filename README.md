# Symphony-TS

Agent-agnostic coding-agent orchestrator — a TypeScript reimplementation of [Symphony](../SPEC.md).
A **single-user local app** for delegating tasks to coding agents: create tickets in a **local
file-based task store**, and Symphony-TS auto-delegates each to a **local Claude Code** agent running
in an isolated git worktree, keeping it working until the ticket reaches a terminal state. No SaaS, no
Docker, no database, no authentication — everything runs on your machine and state is plain JSON under
`~/.symphony`.

v1 targets Claude Code but is **agent-agnostic**: Codex CLI, opencode, and others plug in behind one
`CodingAgentBackend` interface (hybrid — Claude Agent SDK for Claude, CLI stream-json for the rest).

## Layout

```
packages/
  shared/         # cross-package types (NormalizedIssue, Result, errors)
  tracker/        # Tracker interface + local file-store adapter (FileTracker) + in-memory mock
  agent-backends/ # CodingAgentBackend interface + Claude SDK / CLI stream-json backends
  core/           # orchestrator, config, workflow, prompt, workspace, tracker bridge, observability
apps/
  cli/            # `symphony` binary (run orchestrator + `ticket create`)
  dashboard/      # fastify JSON API + Preact/Vite kanban dashboard
```

## Develop

Requires Node ≥ 22 and pnpm. Uses the host's existing `claude` login (`~/.claude`).

```bash
pnpm install
pnpm build         # tsup, all packages (+ vite for the dashboard client)
pnpm test          # vitest, all packages
pnpm typecheck     # tsc --noEmit, all packages
pnpm lint          # eslint
pnpm format        # prettier --write
```

## Run

No services to start — the task store is just local files (default `~/.symphony`).

1. Copy `WORKFLOW.md.example` to `WORKFLOW.md` and set `workspace.repo` (a local git repo with at
   least one commit, or a git URL). The defaults give you a `file` tracker at `~/.symphony` with the
   project key `default` and the Symphony workflow states.
2. Build and run:

```bash
pnpm install && pnpm build
node apps/cli/dist/main.js ./WORKFLOW.md --port 4500   # dashboard at http://127.0.0.1:4500/
```

3. Create a ticket from the terminal (or use the dashboard's "+ New ticket"):

```bash
node apps/cli/dist/main.js ticket create "Add dark mode" --desc "..." --state Todo
```

Install the `symphony` command globally for convenience:

```bash
pnpm --filter @symphony/cli build
pnpm --filter @symphony/cli link --global   # or: npm i -g ./apps/cli
symphony --help
symphony ./WORKFLOW.md --port 4500
symphony ticket create "Add dark mode" --state Todo
```

Agent auth uses your existing local `claude` login (`~/.claude`). The agent drives the ticket itself
via purpose-built tracker tools — `tracker_get_task`, `tracker_update_status`, `tracker_add_comment` —
moving it to **Human Review** with an evidence comment when done; the orchestrator only reads ticket
state.

The dashboard header has a **project switcher** (switch between registered projects, or "+ New
project" to create one + register its repo). Each project is a git repo plus its own task store under
`~/.symphony/projects/<key>/`. Switching live re-points the orchestrator — running agents stop, the
tracker + repo swap, and polling resumes — with no restart. A **Settings** panel edits runtime
preferences (backend, concurrency, timeouts, poll interval, branch prefix), persisted to `WORKFLOW.md`
and applied live. Registered projects live in `WORKFLOW.md` `projects:`.

> The dashboard has **no authentication** — keep `server.host` on loopback (`127.0.0.1`). Binding to
> a public host logs a warning and exposes the API to the network.

### Where state lives

Everything is plain JSON under `tracker.data_root` (default `~/.symphony`):

```
~/.symphony/
  tracker.sock                       # internal bridge socket (CLI-backend agents → orchestrator)
  projects/<projectKey>/
    meta.json                        # { identifier, next_seq }  ← issue ids: <IDENTIFIER>-<n>
    states.json                      # board lanes (seeded from your active/terminal/review states)
    labels.json
    issues/<ID>.json                 # the issue
    issues/<ID>/comments.jsonl       # comments
    issues/<ID>/activity.jsonl       # change history
    uploads/<uuid>/<file>            # ticket attachments (saved as local files)
```

Inspect a ticket with `cat ~/.symphony/projects/default/issues/SYM-1.json`; reset a project by
deleting its directory. Worktrees and the shared clone live under `workspace.root` (separate from the
task store), and are preserved after success and cleaned only when an issue goes terminal.

### Agent prompting

The agent runs with two Claude-optimized layers:

- a **system prompt** = Claude Code's built-in preset + Symphony's operating contract (identity, the
  gather → act → verify loop, workspace/scope containment, the tracker protocol, verification/"done",
  and safety). It lives in `packages/core/src/prompt/system-prompt.ts`; override it wholesale with
  `agent.system_prompt`.
- a lean **per-issue prompt** rendered from the `WORKFLOW.md` body (Liquid, `issue.*` vars).

The agent never writes raw REST: it uses the semantic tools `tracker_get_task`, `tracker_update_status`
(it may only set active + `review_state`, never terminal), and `tracker_add_comment`. For CLI backends
those calls are proxied to the orchestrator over an internal Unix-socket bridge, so the orchestrator
process stays the single writer of the file store. Tune reasoning with `agent.effort` (`low…max`) /
`agent.thinking` (`adaptive`/`disabled`).

### tmux supervision (CLI backends)

Set `agent.tmux: true` to run each turn of a **CLI backend** (`claude-cli`/`codex-cli`/`opencode-cli`)
inside a detached tmux session. You can then `tmux attach -t symphony-<issue-id>` to watch the agent
live, and the raw stdout stream is `tee`'d to `<logs_root>/<issue-id>/<turn>/run.jsonl` for
post-mortem. Terminating a session (dashboard or `POST /api/v1/sessions/:id/terminate`) runs
`tmux kill-session`. Logs default to `<tmpdir>/symphony_logs`; override with `--logs-root <dir>` or
`logs_root` in `WORKFLOW.md`. tmux has **no effect** on the in-process `claude-sdk` backend.

```bash
node apps/cli/dist/main.js ./WORKFLOW.md --port 4500 --logs-root ~/symphony-logs
tmux ls                            # symphony-SYM-12
tmux attach -t symphony-SYM-12     # watch it work
```

### Failure recovery & reliability

Symphony drives the local Claude Code defensively (all knobs live under `agent.*` in `WORKFLOW.md`):

- **Category-aware retry** — failures are classified (auth, rate-limit, upstream, prompt-too-large,
  timeout, idle, process-crash, …) with a derived `retryable` bit. Permanent failures go straight to
  **blocked** for operator input; transient ones retry on a **jittered** backoff up to
  `max_failure_retries` (default 5; `0` = unlimited), then block — no more infinite retry loops.
- **Idle watchdog** — `idle_timeout_ms` (default 5m, `0` disables) kills a turn whose stream goes silent
  (hung tool / upstream stall), far faster than the 1h hard `turn_timeout_ms`. It resets on every event,
  so long-but-active tool runs survive.
- **Resume-on-failure** — a transient failure (or a continuation) resumes the agent's CLI session on the
  next attempt **when work was already done** (a tool ran), instead of restarting cold.
- **Fail-fast detection** — the configured agent binary is PATH-probed once at startup (with a `--help`
  capability probe); a missing binary skips dispatch with a clear reason. `agent.command` overrides the
  binary (e.g. a wrapper or non-PATH `claude`).
- **Hermetic by default, configurable** — `setting_sources` (default `['project','local']`) and
  `strict_mcp_config` (default true) keep per-issue runs reproducible and prevent inherited host MCP
  servers from stalling a turn. Add `user` to `setting_sources` to inherit your host-global `~/.claude`.
- **Durable audit log** — `persist_run_log` (default true) writes every run's events to
  `<logs_root>/<issue-id>/<turn>/events.jsonl` (secrets redacted) for **all** backends, not just tmux.
- **Live streaming** — opt in with `stream_partial_messages: true` (CLI flag auto-gated on the build's
  capability) for token-level dashboard updates.

## Conventions

- TS strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM (`NodeNext`).
- Internal imports use the package name (`@symphony/shared`) and `.js` extensions on relative imports.
- Each package builds with tsup (emits its own `.d.ts`); no project references / `tsc -b`.
- Keep the orchestrator agent-neutral — agent specifics live only in `agent-backends`.

## License

Apache-2.0 (inherits the parent project).
