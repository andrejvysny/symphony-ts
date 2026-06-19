# @andrejvysny/symphony

A local **web dashboard** for delegating coding tasks to AI agents. Create tickets on a kanban
board, and Symphony runs a local coding agent (Claude Code by default) on each one in the background
— you watch progress live in the browser. Single-user, runs entirely on your machine: no SaaS, no
Docker, no database, no login. State is plain JSON under `~/.symphony`.

## Install

```bash
npm install -g @andrejvysny/symphony
```

> Requires **Node ≥ 22**. The default agent uses your local **`claude` login** (`~/.claude`).

## Launch the dashboard

**1. (Optional) scaffold a config:**

```bash
symphony init        # writes a WORKFLOW.md you can edit
```

**2. Start it:**

```bash
symphony --port 4500
```

> Zero-config is fine: `symphony --port 4500` runs with sensible defaults even without a
> `WORKFLOW.md`, and the dashboard prompts you to create a project. `symphony init` just gives you a
> file to customize.

**3. Open the dashboard:** **http://127.0.0.1:4500**

From there you can create a project (point it at a local git repo), add tickets, and watch the agent
work them in real time.

## In the dashboard

- **Kanban board** — Backlog · Todo · In Progress · Human Review · Done, updating live as the agent works.
- **Create tickets** — title, description, priority; the agent picks them up automatically.
- **Live agent view** — the agent's plan (TodoWrite checklist) and activity stream per ticket.
- **Projects** — switch between repos, or create a new one, without restarting.
- **Settings** — backend, concurrency, timeouts, poll interval — applied live.

## CLI

```bash
symphony init                                 # write a starter WORKFLOW.md (optional)
symphony --port 4500                          # run the orchestrator + dashboard (zero-config OK)
symphony ticket create "Add dark mode" --state Todo   # create a ticket from the terminal
symphony --help
symphony --version
```

## Security

The dashboard has **no authentication** — keep it on loopback (`127.0.0.1`, the default). Binding to
a public host exposes the API to your network.

## Links

- Full docs, configuration reference, and source: **https://github.com/andrejvysny/symphony-ts**
- Annotated config: [`WORKFLOW.md.example`](https://github.com/andrejvysny/symphony-ts/blob/master/WORKFLOW.md.example)

## License

Apache-2.0
