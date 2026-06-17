// Offline end-to-end dry-run: drives the REAL local Claude Code (claude-sdk) on a
// throwaway git repo against in-memory tickets — NO Linear, NO network tracker. Proves
// the full delegation loop in parallel: dispatch -> per-issue git worktree -> Claude
// implements + commits -> agent parks its ticket via an in-process MCP tool -> worker
// post-turn refresh sees the non-active state -> release + PRESERVE the worktree.
//
// Requires: a working local `claude` login (~/.claude) — the same one this CLI uses.
// It spends a small amount on the model (trivial one-file tasks, per-run budget cap).
//
//   node scripts/dry-run-claude.mjs                 # 3 tickets, dashboard :4500
//   SYMPHONY_DRYRUN_TICKETS=2 node scripts/dry-run-claude.mjs
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import {
  Orchestrator,
  PromptBuilder,
  WorkspaceManager,
  buildBackend,
  buildDashboardSource,
  createLogger,
  parseConfig,
  resolveConfig,
} from '../packages/core/dist/index.js';
import {
  MemoryTracker,
  makeAddCommentExecutor,
  makeSetIssueStateExecutor,
} from '../packages/tracker/dist/index.js';
import { buildMemorySdkMcpServer } from '../packages/agent-backends/dist/index.js';
import { startDashboard } from '../apps/dashboard/dist/index.js';

const run = promisify(execFile);
const PORT = Number(process.env.SYMPHONY_DEMO_PORT ?? 4500);
const TICKETS = Math.max(1, Math.min(4, Number(process.env.SYMPHONY_DRYRUN_TICKETS ?? 3)));
const PARK_STATE = 'Human Review';
const DEADLINE_MS = Number(process.env.SYMPHONY_DRYRUN_DEADLINE_MS ?? 12 * 60_000);
const logger = createLogger({ pretty: true });

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// 1) Throwaway source repo with one commit (identity set on the SOURCE only — the agent's
//    commit in the cloned worktree relies on the after_create hook below, exactly like live).
const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-dryrun-'));
const repo = path.join(tmp, 'source-repo');
const root = path.join(tmp, 'workspaces');
await mkdir(repo, { recursive: true });
const git = (args, cwd = repo) => run('git', args, { cwd });
await git(['init', '-b', 'main']);
await git(['config', 'user.email', 'source@example.com']);
await git(['config', 'user.name', 'Source']);
await run('node', ['-e', "require('fs').writeFileSync('README.md', '# dry-run playground\\n')"], {
  cwd: repo,
});
await git(['add', '.']);
await git(['commit', '-m', 'init']);

// 2) Seed trivial, cheap tickets (one-file changes) in an in-memory tracker.
const iso = new Date(0).toISOString();
const SEED = [
  { title: 'Create a file GREETING.md containing exactly the word: hello' },
  { title: 'Create a file NOTES.md with a single line: dry-run note' },
  { title: 'Append a line "dry-run ok" to README.md' },
  { title: 'Create a file STATUS.txt containing the word: ok' },
].slice(0, TICKETS);
const seeded = SEED.map((s, i) => ({
  id: `mem-${i + 1}`,
  identifier: `MEM-${i + 1}`,
  title: s.title,
  description: 'Keep the change minimal and trivial; this only validates the orchestration loop.',
  priority: null,
  state: 'Todo',
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: iso,
  updatedAt: iso,
}));

const tracker = new MemoryTracker({
  issues: seeded,
  activeStates: ['Todo', 'In Progress'],
  terminalStates: ['Done', 'Canceled'],
  states: [
    { id: 'Todo', name: 'Todo', type: 'unstarted', position: 0 },
    { id: 'In Progress', name: 'In Progress', type: 'started', position: 1 },
    { id: PARK_STATE, name: PARK_STATE, type: 'started', position: 2 },
    { id: 'Done', name: 'Done', type: 'completed', position: 3 },
  ],
});

// 3) Config: real claude-sdk backend, parallel 3, autonomous, small bounds. after_create sets
//    a git identity in each fresh worktree (the .repo clone does NOT inherit one).
const config = resolveConfig(
  parseConfig({
    tracker: {
      kind: 'memory',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done', 'Canceled'],
    },
    workspace: { repo, root, branch_prefix: 'symphony/' },
    hooks: {
      after_create: [
        'git config user.email "agent@symphony.local"',
        'git config user.name "Symphony Agent"',
      ].join('\n'),
    },
    agent: {
      backend: 'claude-sdk',
      permission_mode: 'bypassPermissions',
      max_concurrent_agents: TICKETS,
      max_turns: 2,
      max_continuations: 1,
      max_budget_usd: 1,
      turn_timeout_ms: 300_000,
      stall_timeout_ms: 600_000,
    },
    polling: { interval_ms: 3000 },
  }),
  tmp,
);

// 4) Memory MCP server (per-run factory) so the offline agent can park its own ticket —
//    the offline parallel to the live mcp__symphony__linear_graphql state move.
const setState = makeSetIssueStateExecutor(tracker);
const addComment = makeAddCommentExecutor(tracker);
const mcpConfig = { sdkServers: () => buildMemorySdkMcpServer(setState, addComment) };

const prompt = `You are an autonomous coding agent working in an isolated git worktree on a tiny task.

Issue id: {{ issue.id }}
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
{% if issue.description %}Details: {{ issue.description }}{% endif %}

Do EXACTLY this, then stop:
1. Make the small change described in the title (create or edit ONE file). Keep it minimal.
2. Stage and commit: run \`git add -A\` then \`git commit -m "{{ issue.identifier }}: <short message>"\`.
3. Park the ticket by calling the tool \`mcp__symphony__set_issue_state\` with arguments
   { "issueId": "{{ issue.id }}", "state": "${PARK_STATE}" }.
4. Optionally call \`mcp__symphony__add_comment\` with { "issueId": "{{ issue.id }}", "body": "<one-line summary>" }.

Do not ask questions. Do not push. Once the ticket is parked you are done.`;

const workspaceManager = new WorkspaceManager(config.workspace, config.hooks);
await workspaceManager.init();

const orchestrator = new Orchestrator({
  tracker,
  backend: buildBackend(config),
  workspaceManager,
  config,
  logger,
  promptBuilder: new PromptBuilder(prompt),
  mcpConfig,
});

const dashboard = await startDashboard(buildDashboardSource(orchestrator, tracker), { port: PORT });
logger.info(
  { dashboard: `http://127.0.0.1:${dashboard.port}/`, tickets: TICKETS },
  'dry-run started',
);
orchestrator.start();

// Track peak per-issue tokens while running (cleared from snapshot once released).
const peakTokens = new Map();
const isActive = (s) => s === 'Todo' || s === 'In Progress';

let stopped = false;
const finish = async (code) => {
  if (stopped) return;
  stopped = true;
  await dashboard.close().catch(() => {});
  await orchestrator.stop().catch(() => {});
  process.exit(code);
};
process.on('SIGINT', () => void finish(130));
process.on('SIGTERM', () => void finish(143));

const start = Date.now();
while (Date.now() - start < DEADLINE_MS) {
  await new Promise((r) => setTimeout(r, 3000));
  const snap = orchestrator.snapshot();
  for (const r of snap.running) peakTokens.set(r.issue_identifier, r.tokens.total_tokens);
  const states = seeded.map((s) => tracker.get(s.id)?.state ?? '(gone)');
  const active = states.filter(isActive).length;
  logger.info(
    {
      states,
      running: snap.counts.running,
      blocked: snap.counts.blocked,
      tokens: snap.codex_totals.total_tokens,
    },
    'dry-run progress',
  );
  if (active === 0 && snap.counts.running === 0 && snap.counts.retrying === 0) break;
}

// Assertions.
const failures = [];
const snap = orchestrator.snapshot();
for (const s of seeded) {
  const issue = tracker.get(s.id);
  const wt = path.join(root, s.identifier);
  if (issue?.state !== PARK_STATE)
    failures.push(`${s.identifier}: state is "${issue?.state}", expected "${PARK_STATE}"`);
  if (!(await exists(wt)))
    failures.push(`${s.identifier}: worktree missing (should be preserved): ${wt}`);
  else {
    try {
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], wt)).stdout.trim();
      if (branch !== `symphony/${s.identifier}`)
        failures.push(`${s.identifier}: branch is ${branch}`);
      const count = (await git(['rev-list', '--count', 'HEAD'], wt)).stdout.trim();
      if (Number(count) < 2)
        failures.push(
          `${s.identifier}: expected an agent commit on top of init (rev count ${count})`,
        );
    } catch (e) {
      failures.push(`${s.identifier}: git inspect failed: ${e.message}`);
    }
  }
}
if (snap.codex_totals.total_tokens <= 0)
  failures.push('aggregate token total is 0 (token accounting not flowing)');

const parked = seeded.filter((s) => tracker.get(s.id)?.state === PARK_STATE).length;
logger.info(
  {
    parked: `${parked}/${seeded.length}`,
    blocked: snap.counts.blocked,
    tokens: snap.codex_totals.total_tokens,
    peak_per_issue: Object.fromEntries(peakTokens),
    workspaces_root: root,
  },
  failures.length === 0 ? 'DRY-RUN PASS ✅' : 'DRY-RUN FAIL ❌',
);
for (const f of failures) logger.error({}, `  - ${f}`);
logger.info({ root }, 'worktrees preserved for inspection; tmp dir is left in place');

await finish(failures.length === 0 ? 0 : 1);
