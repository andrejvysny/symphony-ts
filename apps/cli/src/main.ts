import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildBackend,
  buildDashboardSource,
  buildMcpConfig,
  buildTracker,
  buildWorkspaceManager,
  CORE_VERSION,
  hasActiveProject,
  createLogger,
  type Logger,
  loadConfig,
  Orchestrator,
  PromptBuilder,
  startTrackerBridge,
  type TrackerBridge,
  trackerSocketPath,
  WORKFLOW_TEMPLATE,
  WorkflowStore,
} from '@symphony/core';
import { startDashboard } from '@symphony/dashboard';
import { FileTracker, makeFileSemanticTools, supportsIssueCreation } from '@symphony/tracker';

interface Args {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (/^-[a-zA-Z]$/.test(a)) {
      // Short boolean flags (e.g. -h, -v). Values for `--flag <value>` are consumed above, so a
      // single-dash token only reaches here when it is a standalone short flag.
      flags.set(a.slice(1), true);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function workflowPath(args: Args): string {
  const explicit = args.flags.get('workflow');
  if (typeof explicit === 'string') return path.resolve(explicit);
  const firstPositional = args.positionals[0];
  if (firstPositional && firstPositional.endsWith('.md')) return path.resolve(firstPositional);
  return path.resolve('WORKFLOW.md');
}

async function runInit(args: Args): Promise<void> {
  // `symphony init [path]` / `symphony init --workflow <path>` — scaffold a starter WORKFLOW.md.
  const explicit = args.flags.get('workflow');
  const positional = args.positionals[1];
  const target = path.resolve(
    typeof explicit === 'string' ? explicit : (positional ?? 'WORKFLOW.md'),
  );
  if (existsSync(target) && !args.flags.has('force')) {
    process.stderr.write(`symphony: ${target} already exists (use --force to overwrite)\n`);
    process.exitCode = 1;
    return;
  }
  await writeFile(target, WORKFLOW_TEMPLATE, 'utf8');
  process.stdout.write(
    `created ${target}\n\nNext: edit it if you like, then run:\n  symphony --port 4500\n` +
      `Open http://127.0.0.1:4500/ and use "+ New project" to point Symphony at a git repo.\n`,
  );
}

async function runTicketCreate(args: Args): Promise<void> {
  const title = args.positionals[2]; // ticket create <title>
  if (!title) {
    process.stderr.write(
      'usage: symphony ticket create "<title>" [--desc ..] [--state ..] [--priority N]\n',
    );
    process.exitCode = 1;
    return;
  }
  const wf = workflowPath(args);
  if (!existsSync(wf)) {
    process.stderr.write(
      `symphony: no WORKFLOW.md at ${wf}\n` +
        `Run \`symphony init\` to create one, then \`symphony --port 4500\` and create a project ` +
        `in the dashboard before adding tickets.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const { config } = await loadConfig(wf);
  const tracker = buildTracker(config);
  if (!supportsIssueCreation(tracker)) {
    process.stderr.write(`tracker "${tracker.kind}" does not support issue creation\n`);
    process.exitCode = 1;
    return;
  }
  const desc = args.flags.get('desc');
  const state = args.flags.get('state');
  const priority = args.flags.get('priority');
  const issue = await tracker.createIssue({
    title,
    ...(typeof desc === 'string' ? { description: desc } : {}),
    ...(typeof state === 'string' ? { stateName: state } : {}),
    ...(typeof priority === 'string' ? { priority: Number(priority) } : {}),
  });
  process.stdout.write(`created ${issue.identifier} (${issue.id})\n`);
}

let activeLogger: Logger | undefined;

async function runOrchestrator(args: Args): Promise<void> {
  const logger = createLogger({ pretty: !args.flags.has('json-logs') });
  activeLogger = logger;
  const wf = workflowPath(args);
  // Zero-config: a missing WORKFLOW.md loads defaults (no active project) so the dashboard can drive
  // setup. Creating a project there writes the file back via the store.
  const store = new WorkflowStore(wf, { logger, allowMissing: true });
  if (!existsSync(wf))
    logger.info(
      {},
      'no WORKFLOW.md found — running with defaults; create a project in the dashboard, or run `symphony init`',
    );
  const { config, promptBody } = await store.load();
  const logsRootFlag = args.flags.get('logs-root');
  if (typeof logsRootFlag === 'string') config.logs_root = path.resolve(logsRootFlag);
  store.start();
  logger.info(
    { tracker: config.tracker.kind, backend: config.agent.backend },
    `loaded workflow ${workflowPath(args)}`,
  );

  const tracker = buildTracker(config);
  const backend = buildBackend(config);
  const workspaceManager = buildWorkspaceManager(config);
  // No active project → skip workspace init (it requires workspace.repo). Opening/creating a project
  // from the dashboard rebuilds + inits the workspace via switchProject.
  if (hasActiveProject(config)) await workspaceManager.init();
  const mcpConfig = buildMcpConfig(config);

  const orchestrator = new Orchestrator({
    tracker,
    backend,
    workspaceManager,
    config,
    logger,
    promptBuilder: new PromptBuilder(promptBody),
    reload: () => store.snapshot(),
    // Factories let the dashboard live-switch the active project (rebuild tracker/mcp/workspace).
    trackerFactory: buildTracker,
    mcpConfigFactory: buildMcpConfig,
    workspaceManagerFactory: buildWorkspaceManager,
    ...(mcpConfig !== undefined ? { mcpConfig } : {}),
  });

  // Single-writer bridge: CLI agents (separate processes) drive the file tracker through here so
  // the orchestrator process is the only file writer. The SDK backend uses in-process tools instead.
  let bridge: TrackerBridge | undefined;
  if (config.tracker.kind === 'file') {
    const allowed = (): string[] => {
      const c = orchestrator.currentConfig().tracker;
      return [...new Set([...c.active_states, c.review_state])];
    };
    bridge = await startTrackerBridge({
      socketPath: trackerSocketPath(config),
      resolveTools: () => {
        const tr = orchestrator.currentTracker();
        if (!(tr instanceof FileTracker)) throw new Error('tracker bridge requires a file tracker');
        return makeFileSemanticTools(tr, allowed());
      },
    });
    logger.info({ socket: bridge.socketPath }, 'tracker bridge listening');
  }

  const portFlag = args.flags.get('port');
  const port = typeof portFlag === 'string' ? Number(portFlag) : (config.server?.port ?? undefined);
  if (typeof portFlag === 'string' && !(Number.isInteger(port) && port! >= 0 && port! <= 65535))
    logger.warn({ port: portFlag }, 'ignoring invalid --port (expected an integer 0–65535)');
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  if (port !== undefined && Number.isInteger(port) && port >= 0 && port <= 65535) {
    dashboard = await startDashboard(buildDashboardSource(orchestrator, store), {
      port,
      host: config.server?.host ?? '127.0.0.1',
      onNonLoopback: (h) =>
        logger.warn(
          { host: h },
          'dashboard bound to a non-loopback host and has NO auth — exposed to the network',
        ),
    });
    logger.info(
      { port: dashboard.port },
      `dashboard at http://${config.server?.host ?? '127.0.0.1'}:${dashboard.port}/`,
    );
  }

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({}, 'shutting down');
    store.stop();
    if (dashboard) await dashboard.close();
    if (bridge) await bridge.close();
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  orchestrator.start();
  logger.info({}, 'orchestrator started (Ctrl-C to stop)');
  await new Promise(() => {}); // run forever
}

const HELP = `symphony ${CORE_VERSION} — agent-agnostic coding-agent orchestrator

Usage:
  symphony init [path] [--force]                      Write a starter WORKFLOW.md
  symphony [WORKFLOW.md] [--port <n>] [--json-logs]   Run the orchestrator
  symphony ticket create "<title>" [--desc <t>] [--state <s>] [--priority <n>]
  symphony --version

Options:
  --port <n>      Start the observability dashboard + JSON API on this port
  --logs-root <d> Dir for raw tmux session logs (default: <tmpdir>/symphony_logs)
  --json-logs     Emit structured JSON logs instead of pretty logs
  --workflow <p>  Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --version, -v   Print version
  --help, -h      Show this help

Quick start: \`symphony init\` then \`symphony --port 4500\`. With no WORKFLOW.md, the
orchestrator runs with defaults and the dashboard prompts you to create a project.
Agent auth uses your local \`claude\` login.
`;

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.has('help') || args.flags.has('h') || args.positionals[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (args.flags.has('version') || args.flags.has('v') || args.positionals[0] === 'version') {
    process.stdout.write(`symphony ${CORE_VERSION}\n`);
    return;
  }
  if (args.positionals[0] === 'init') {
    await runInit(args);
    return;
  }
  if (args.positionals[0] === 'ticket' && args.positionals[1] === 'create') {
    await runTicketCreate(args);
    return;
  }
  await runOrchestrator(args);
}

function reportFatal(label: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (activeLogger) activeLogger.error({ label }, message);
  else process.stderr.write(`symphony: ${label}: ${message}\n`);
}

process.on('unhandledRejection', (reason) => {
  reportFatal('unhandledRejection', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  reportFatal('uncaughtException', err);
  process.exit(1);
});

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`symphony: ${(e as Error).message}\n`);
  process.exit(1);
});
