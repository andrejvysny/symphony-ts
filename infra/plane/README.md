# Local Plane (Symphony tracker)

Symphony's tracker is a **local** [Plane](https://plane.so) Community Edition instance run via
Docker Compose on `localhost` — no SaaS, nothing on a remote server. Ticket data lives in Plane's
Postgres; attachments live in Plane's bundled MinIO (a local Docker volume, no cloud).

## Run

```bash
pnpm plane:up      # docker compose up -d (first run pulls ~10 images; give it a few minutes)
pnpm plane:ps      # service status
pnpm plane:logs    # tail logs
pnpm plane:down    # stop (named volumes persist)
```

UI + REST API: **http://localhost** (proxy publishes host port `80`; change `LISTEN_HTTP_PORT` in
`plane.env` if 80 is taken).

## One-time setup (in the UI)

1. Open http://localhost, create the first admin account, then a **Workspace** and a **Project**.
2. Note the `workspace_slug` (from the URL `/<workspace-slug>/`) and the project **UUID** + project
   **identifier** prefix (e.g. `SYM`) from project settings.
3. Configure the project's workflow states to match Symphony's flow (state **group** matters):
   `Todo` (unstarted), `In Progress`/`Rework`/`Merging` (started, active), `Human Review` (started,
   parked for a human), `Done` (completed), `Canceled` (cancelled).
4. Profile → **Personal Access Tokens** → create one → export `PLANE_API_KEY`.
5. Set the tracker block in `../../WORKFLOW.md` (`endpoint: http://localhost`, `workspace_slug`,
   `project_id`) and run Symphony.

## Pinning / upgrading

Release is pinned via `APP_RELEASE` in `plane.env` (currently `v1.3.1`). Bump it and re-run
`pnpm plane:up` to upgrade; the migrator service applies DB migrations automatically.

## Files

- `docker-compose.yml` — vendored verbatim from the Plane CE self-host release.
- `plane.env` — local-only env (passed via `--env-file`); safe for a localhost dev instance.
