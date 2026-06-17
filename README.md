# Symphony-TS

Agent-agnostic coding-agent orchestrator — a TypeScript reimplementation of [Symphony](../SPEC.md).
Create tickets in a **local, self-hosted [Plane](https://plane.so)** instance; Symphony-TS
auto-delegates each to a **local Claude Code** agent running in an isolated git worktree, keeping it
working until the ticket reaches a terminal state. No SaaS — tracker and agent both run on your machine.

v1 targets Claude Code but is **agent-agnostic**: Codex CLI, opencode, and others plug in behind one
`CodingAgentBackend` interface (hybrid — Claude Agent SDK for Claude, CLI stream-json for the rest).

> Status: early build. See the implementation plan at
> `~/.claude/plans/now-your-main-task-gleaming-hopcroft.md` and the upstream contract in `../SPEC.md`.

## Layout

```
packages/
  shared/         # cross-package types (NormalizedIssue, Result, errors)
  tracker/        # Tracker interface + Plane (REST) adapter + in-memory mock
  agent-backends/ # CodingAgentBackend interface + Claude SDK / CLI stream-json backends
  core/           # orchestrator, config, workflow, prompt, workspace, observability
apps/
  cli/            # `symphony` binary (run orchestrator + `ticket create`)
  dashboard/      # fastify observability dashboard + JSON API
```

## Develop

Requires Node ≥ 22 and pnpm. Uses the host's existing `claude` login (`~/.claude`).

```bash
pnpm install
pnpm build         # tsup, all packages
pnpm test          # vitest, all packages
pnpm typecheck     # tsc --noEmit, all packages
pnpm lint          # eslint
pnpm format        # prettier --write
```

## Run

1. Start a **local Plane** instance: `pnpm plane:up` (Docker Compose; see `infra/plane/README.md`).
   Open <http://localhost>, create a Workspace + Project, add the Symphony workflow states (`Todo`,
   `In Progress`, `Rework`, `Merging`, `Human Review`, `Done`, `Cancelled`), then create a Personal
   Access Token and export it: `export PLANE_API_KEY=plane_api_...`.
2. Copy `WORKFLOW.md.example` to `WORKFLOW.md` and set `tracker.workspace_slug`, `tracker.project_id`
   (the project UUID), and `workspace.repo`.
3. Build and run:

```bash
pnpm install && pnpm build
node apps/cli/dist/main.js ./WORKFLOW.md --port 4500   # dashboard at http://127.0.0.1:4500/
```

Create a ticket from the terminal instead of the Linear UI:

```bash
node apps/cli/dist/main.js ticket create "Add dark mode" --desc "..." --state Todo
```

Install the `symphony` command globally for convenience:

```bash
pnpm --filter @symphony/cli build
pnpm --filter @symphony/cli link --global   # or: npm i -g ./apps/cli
symphony --help
symphony ./WORKFLOW.md --port 4500
```

Agent auth uses your existing local `claude` login (`~/.claude`). The agent moves tickets and posts
comments itself via the confined `tracker_api` REST tool; the orchestrator only reads ticket state.

> The dashboard has **no authentication** — keep `server.host` on loopback (`127.0.0.1`). Binding to
> a public host logs a warning and exposes the API to the network.

### tmux supervision (CLI backends)

Set `agent.tmux: true` to run each turn of a **CLI backend** (`claude-cli`/`codex-cli`/`opencode-cli`)
inside a detached tmux session. You can then `tmux attach -t symphony-<issue-id>` to watch the agent
live, and the raw stdout stream is `tee`'d to `<logs_root>/<issue-id>/<turn>/run.jsonl` for
post-mortem. Terminating a session (dashboard or `POST /api/v1/sessions/:id/terminate`) runs
`tmux kill-session`. Logs default to `<tmpdir>/symphony_logs`; override with `--logs-root <dir>` or
`logs_root` in `WORKFLOW.md`. tmux has **no effect** on the in-process `claude-sdk` backend.

```bash
node apps/cli/dist/main.js ./WORKFLOW.md --port 4500 --logs-root ~/symphony-logs
tmux ls                            # symphony-ENG-12
tmux attach -t symphony-ENG-12     # watch it work
```

## Conventions

- TS strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM (`NodeNext`).
- Internal imports use the package name (`@symphony/shared`) and `.js` extensions on relative imports.
- Each package builds with tsup (emits its own `.d.ts`); no project references / `tsc -b`.
- Keep the orchestrator agent-neutral — agent specifics live only in `agent-backends`.

## License

Apache-2.0 (inherits the parent project).
