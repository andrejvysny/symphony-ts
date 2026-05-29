// Local UI demo: a seeded multi-state kanban board served by the real dashboard,
// so you can manually test create / move / sessions / live-logs / terminate without
// Linear or spending tokens. Agents are a safe mock that stays "running" so the
// Sessions panel + live-log console + terminate all have something to act on.
//
//   node scripts/demo.mjs            # dashboard at http://127.0.0.1:4500/
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  Orchestrator,
  PromptBuilder,
  WorkspaceManager,
  buildDashboardSource,
  createLogger,
  parseConfig,
  resolveConfig,
} from '../packages/core/dist/index.js';
import { MemoryTracker } from '../packages/tracker/dist/index.js';
import { startDashboard } from '../apps/dashboard/dist/index.js';

const run = promisify(execFile);
const PORT = Number(process.env.SYMPHONY_DEMO_PORT ?? 4500);
const logger = createLogger({ pretty: true });

// throwaway shared repo for worktrees
const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-demo-'));
const repo = path.join(tmp, 'repo');
await mkdir(repo, { recursive: true });
const git = (args) => run('git', args, { cwd: repo });
await git(['init', '-b', 'main']);
await git(['config', 'user.email', 'demo@example.com']);
await git(['config', 'user.name', 'Symphony Demo']);
await writeFile(path.join(repo, 'README.md'), '# Demo\n');
await git(['add', '.']);
await git(['commit', '-m', 'init']);

const iso = new Date(0).toISOString();
const mk = (id, identifier, title, state, priority = null) => ({
  id,
  identifier,
  title,
  description: `Demo ticket ${identifier}`,
  priority,
  state,
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: iso,
  updatedAt: iso,
});

const states = [
  { id: 'Backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'Todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'In Progress', name: 'In Progress', type: 'started', position: 2 },
  { id: 'Human Review', name: 'Human Review', type: 'started', position: 3 },
  { id: 'Done', name: 'Done', type: 'completed', position: 4 },
];

const tracker = new MemoryTracker({
  activeStates: ['Todo', 'In Progress'],
  terminalStates: ['Done'],
  states,
  issues: [
    mk('d1', 'DEMO-1', 'Add dark mode toggle', 'Todo', 2),
    mk('d2', 'DEMO-2', 'Fix flaky auth test', 'In Progress', 1),
    mk('d3', 'DEMO-3', 'Summarize feedback from Slack', 'Backlog', 3),
    mk('d4', 'DEMO-4', 'Upgrade to latest React', 'Human Review'),
    mk('d5', 'DEMO-5', 'Repeated tasks support', 'Done'),
  ],
});

// Mock backend: emits a few events then stays running until aborted (terminate).
const at = () => new Date().toISOString();
const backend = {
  kind: 'demo',
  async *run(opts) {
    yield {
      type: 'session_started',
      sessionId: `sess-${opts.issueRef?.identifier ?? '?'}`,
      at: at(),
    };
    yield { type: 'text_delta', text: `Working on ${opts.issueRef?.identifier}…`, at: at() };
    yield { type: 'tool_use', toolName: 'Read', toolUseId: 't1', input: {}, at: at() };
    yield {
      type: 'usage',
      inputTokens: 800,
      outputTokens: 120,
      totalTokens: 920,
      absolute: true,
      at: at(),
    };
    yield { type: 'text_delta', text: 'Editing files…', at: at() };
    await new Promise((resolve) => {
      if (opts.signal?.aborted) return resolve();
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    const result = { status: 'success', inputTokens: 800, outputTokens: 120, totalTokens: 920 };
    yield { type: 'result', result, at: at() };
    return result;
  },
};

const config = resolveConfig(
  parseConfig({
    tracker: { kind: 'memory' },
    workspace: { repo, root: path.join(tmp, 'workspaces') },
    agent: { max_turns: 1, stall_timeout_ms: 0, permission_mode: 'bypassPermissions' },
    polling: { interval_ms: 2000 },
  }),
  tmp,
);

const workspaceManager = new WorkspaceManager(config.workspace, config.hooks);
await workspaceManager.init();

const orchestrator = new Orchestrator({
  tracker,
  backend,
  workspaceManager,
  config,
  promptBuilder: new PromptBuilder('Work on {{ issue.identifier }}'),
  logger,
});

const dashboard = await startDashboard(buildDashboardSource(orchestrator, tracker), { port: PORT });
orchestrator.start();
logger.info(
  { dashboard: `http://127.0.0.1:${dashboard.port}/` },
  'demo board running — Ctrl-C to stop',
);

const shutdown = async () => {
  await dashboard.close();
  await orchestrator.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
