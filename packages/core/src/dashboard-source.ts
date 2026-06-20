import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, ClaudeUsageLimits } from '@symphony/agent-backends';
import { getClaudeUsageLimits } from '@symphony/agent-backends';
import type { AgentEffort, IssuePlan, PlanStatus, PlanTextAnchor } from '@symphony/shared';
import {
  listProjectKeys,
  scaffoldProject,
  seedStates,
  supportsActivity,
  supportsBoard,
  supportsIssueCreation,
  supportsIssueRemoval,
  supportsIssueWriter,
  type IssuePatch,
  type LabelInfo,
} from '@symphony/tracker';
import type { ProjectEntry } from './config/schema.js';
import type { WorkflowStore } from './workflow/store.js';
import { sanitizeIdentifier } from './workspace/path-safety.js';
import type {
  Orchestrator,
  OrchestratorSnapshot,
  RuntimeInfo,
  SessionInfo,
} from './orchestrator/orchestrator.js';

export interface BoardStateDTO {
  id: string;
  name: string;
  type: string;
  position: number;
  color?: string;
}

export type IssueStatus = 'running' | 'blocked' | 'retrying' | 'paused' | 'idle';

export interface BoardIssueDTO {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: number | null;
  labels: string[];
  url: string | null;
  status: IssueStatus;
  createdAt: string | null;
  updatedAt: string | null;
  /** Plan-mode status for the card badge (planning / awaiting_input / ready / approved); null = no plan. */
  plan_status: PlanStatus | null;
}

export interface IssueActivityDTO {
  at: string;
  field: string | null;
  verb: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface IssueCommentDTO {
  at: string;
  body: string;
}

/** Full ticket detail for the dashboard detail view: issue + history + comments + live status. */
export interface IssueDetailDTO {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  priority: number | null;
  labels: string[];
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  status: IssueStatus;
  activity: IssueActivityDTO[];
  comments: IssueCommentDTO[];
  /** Attachment records persisted on the issue (asset url + title). */
  attachments: Array<{ url: string; title: string }>;
  /** Per-task agent overrides (null = inherit the global agent config). */
  model: string | null;
  effort: AgentEffort | null;
  /** Token/cost usage for the task: live counts while running, else the persisted total; null when none. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number | null;
  } | null;
  /** Absolute path of the issue's git worktree when it exists on disk (for "Open in VS Code");
   *  null for issues that have never run (no worktree yet) or after terminal cleanup. */
  worktree_path: string | null;
  /** Plan-mode artifact (generated plan + Q&A + comments); null until a plan run starts. */
  plan: IssuePlan | null;
}

export interface BoardData {
  states: BoardStateDTO[];
  /** Issues grouped by state name (one key per state, plus any unknown states found). */
  columns: Record<string, BoardIssueDTO[]>;
}

export interface CreateTicketFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface CreateTicketInput {
  title: string;
  description?: string;
  stateId?: string;
  files?: CreateTicketFile[];
  /** Per-task agent overrides (fall back to the global agent config). */
  model?: string;
  effort?: AgentEffort;
}

/** Operator edits from the dashboard ticket modal. `labels` are names (resolved to ids here). */
export interface IssueEditInput {
  title?: string;
  description?: string;
  priority?: number | null;
  labels?: string[];
  /** Per-task agent overrides; null clears back to the global agent config. */
  model?: string | null;
  effort?: AgentEffort | null;
}

/** A switchable project for the dashboard's project switcher. */
export interface ProjectDTO {
  project_id: string;
  name: string;
  identifier: string | null;
  /** Local git repo folder from the registry; null when the project isn't registered. */
  repo: string | null;
  /** Absolute, ~-expanded repo path for an "open folder" link; null when unknown. */
  repo_path: string | null;
  /** Present in the WORKFLOW.md `projects` registry (switchable). */
  registered: boolean;
  /** Currently the active project. */
  active: boolean;
}

export interface ProjectsDTO {
  projects: ProjectDTO[];
  active_project_id: string | null;
}

export interface CreateProjectInput {
  name: string;
  identifier: string;
  repo: string;
}

/** Operator edits to a registered project from the manage-projects modal. */
export interface UpdateProjectInput {
  /** Rename the human-readable name (the `project_id` key is immutable). */
  name?: string;
  /** Re-point the git repo folder; re-inits the workspace when the project is active. */
  repo?: string;
}

/** Runtime preferences exposed by the settings screen (curated subset of the config). */
export interface SettingsDTO {
  agent: {
    backend: string;
    model: string | null;
    permission_mode: string;
    max_turns: number;
    max_continuations: number;
    max_concurrent_agents: number;
    max_retry_backoff_ms: number;
    turn_timeout_ms: number;
    stall_timeout_ms: number;
    tmux: boolean;
    max_budget_usd: number | null;
  };
  polling: { interval_ms: number };
  workspace: { branch_prefix: string; mode: string; merge_on_accept: boolean };
  /** Plan-mode settings (the read-only "Plan" track). */
  plan: { qa_mode: string };
}

export interface SettingsAgentPatch {
  backend?: string;
  model?: string | null;
  permission_mode?: string;
  max_turns?: number;
  max_continuations?: number;
  max_concurrent_agents?: number;
  max_retry_backoff_ms?: number;
  turn_timeout_ms?: number;
  stall_timeout_ms?: number;
  tmux?: boolean;
  max_budget_usd?: number | null;
}

export interface SettingsPatch {
  agent?: SettingsAgentPatch;
  polling?: { interval_ms?: number };
  workspace?: { branch_prefix?: string; mode?: string; merge_on_accept?: boolean };
  plan?: { qa_mode?: string };
}

/** The capability surface the dashboard consumes. */
export interface DashboardSource {
  snapshot(): OrchestratorSnapshot;
  runtimeInfo(): RuntimeInfo;
  findIssue(identifier: string): unknown;
  requestRefresh(): Promise<{ coalesced: boolean }>;
  capabilities(): {
    board: boolean;
    write: boolean;
    projects: boolean;
    settings: boolean;
    usage_limits: boolean;
    /** Whether a project is currently active; false → the dashboard shows a create/open prompt. */
    activeProject: boolean;
  };
  listProjects(): Promise<ProjectsDTO>;
  switchProject(projectId: string): Promise<{ switched: boolean }>;
  createProject(input: CreateProjectInput): Promise<ProjectDTO>;
  /** Re-point and/or rename a registered project. */
  updateProject(projectId: string, input: UpdateProjectInput): Promise<ProjectDTO>;
  /** Unregister a project from the registry (keeps its on-disk data); refuses the active project. */
  removeProject(projectId: string): Promise<{ removed: boolean }>;
  /** Detach the active project (no project active) so the dashboard shows the create/open prompt. */
  closeProject(): Promise<{ closed: boolean }>;
  getSettings(): SettingsDTO;
  updateSettings(patch: SettingsPatch): Promise<void>;
  /** Claude subscription usage limits (5h + weekly) for the top-bar gauge; cached server-side. */
  getUsageLimits(): Promise<ClaudeUsageLimits>;
  getBoard(): Promise<BoardData>;
  getIssueDetail(id: string): Promise<IssueDetailDTO | null>;
  listStates(): Promise<BoardStateDTO[]>;
  listLabels(): Promise<LabelInfo[]>;
  createTicket(input: CreateTicketInput): Promise<{ id: string; identifier: string }>;
  /** Resolve an attachment URL (`/api/v1/uploads/<projectKey>/<rest>`) to a safe absolute file path. */
  resolveUpload(projectKey: string, rest: string): string | null;
  moveIssue(issueId: string, stateId: string): Promise<void>;
  updateIssue(issueId: string, edit: IssueEditInput): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  /** Permanently delete an issue (refused while it has a running agent). */
  deleteIssue(issueId: string): Promise<{ deleted: boolean }>;
  /** Attach an uploaded file to an existing issue. */
  addAttachment(issueId: string, file: CreateTicketFile): Promise<{ url: string; title: string }>;
  /** Remove one attachment (by asset url) from an issue. */
  removeAttachment(issueId: string, url: string): Promise<{ removed: boolean }>;
  listSessions(): SessionInfo[];
  terminate(issueId: string): Promise<{ terminated: boolean }>;
  terminateAll(): Promise<{ terminated: number }>;
  unblock(issueId: string): Promise<{ unblocked: boolean }>;
  // ---- plan mode ----
  getPlan(issueId: string): Promise<IssuePlan | null>;
  startPlan(
    issueId: string,
    customInstructions?: string,
  ): Promise<{ started: boolean; reason?: string }>;
  answerPlanQuestion(
    issueId: string,
    askId: string,
    answers: Record<string, string | string[]>,
  ): Promise<{ ok: boolean; reason?: string }>;
  revisePlan(issueId: string): Promise<{ ok: boolean; reason?: string }>;
  editPlan(issueId: string, markdown: string): Promise<{ ok: boolean; reason?: string }>;
  addPlanComment(issueId: string, anchor: PlanTextAnchor, body: string): Promise<{ id: string }>;
  resolvePlanComment(
    issueId: string,
    commentId: string,
    resolved: boolean,
  ): Promise<{ ok: boolean }>;
  approvePlan(issueId: string): Promise<{ approved: boolean; reason?: string }>;
  cancelPlan(issueId: string): Promise<{ cancelled: boolean }>;
  subscribeLogs(issueId: string, cb: (ev: AgentEvent) => void): () => void;
  /** Subscribe to global board/state changes (SSE); fires after every settled orchestrator mutation. */
  subscribeBoard(cb: () => void): () => void;
}

/** Expand a leading `~` to an absolute path (for an "open folder" link). */
function expandHome(p: string | null | undefined): string | null {
  if (!p) return null;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The active project id, or null when none is configured. There is NO implicit "default" project —
 * an unset `tracker.project_id` means "no active project" (the dashboard shows a create/open prompt).
 */
function activeProjectId(cfg: ReturnType<Orchestrator['currentConfig']>): string | null {
  return cfg.tracker.project_id ?? null;
}

/** Turn a project name into a unique, path-safe project key (the on-disk directory name). */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'project';
}

/**
 * Build the dashboard source from the orchestrator (operator path). The tracker is read **live** via
 * `orchestrator.currentTracker()` so board/state/etc. follow a project switch. `store` (when present)
 * backs the project-registry + settings write-back; project/settings write ops throw without it.
 */
/** Optional injectables for {@link buildDashboardSource} (test seams). */
export interface DashboardSourceOptions {
  /** Override the Claude usage-limit fetcher (defaults to the real `oauth/usage` call). */
  fetchUsageLimits?: () => Promise<ClaudeUsageLimits>;
}

/** Cache TTL for the undocumented usage-limit fetch — one poll per window, not per client request. */
const USAGE_LIMITS_TTL_MS = 180_000;

export function buildDashboardSource(
  orchestrator: Orchestrator,
  store?: WorkflowStore,
  opts: DashboardSourceOptions = {},
): DashboardSource {
  const fetchUsageLimits = opts.fetchUsageLimits ?? getClaudeUsageLimits;
  let usageLimitsCache: { at: number; value: ClaudeUsageLimits } | null = null;

  function statusOf(id: string, snap: OrchestratorSnapshot): IssueStatus {
    if (snap.running.some((r) => r.issue_id === id)) return 'running';
    if (snap.blocked.some((b) => b.issue_id === id)) return 'blocked';
    if (snap.retrying.some((r) => r.issue_id === id)) return 'retrying';
    if (snap.paused.includes(id)) return 'paused';
    return 'idle';
  }

  function requireStore(): WorkflowStore {
    if (!store) throw new Error('persistence unavailable: no workflow store wired');
    return store;
  }

  return {
    snapshot: () => orchestrator.snapshot(),
    runtimeInfo: () => orchestrator.runtimeInfo(),
    findIssue: (identifier) => orchestrator.findIssue(identifier),
    requestRefresh: () => orchestrator.requestRefresh(),
    capabilities: () => {
      const tracker = orchestrator.currentTracker();
      const cfg = orchestrator.currentConfig();
      return {
        board: supportsBoard(tracker),
        write: supportsIssueWriter(tracker) && supportsIssueCreation(tracker),
        projects: cfg.tracker.kind === 'file' && !!store,
        settings: !!store,
        // Gauge only renders for a Claude backend with the (opt-in) flag on; the gauge component
        // itself handles `available:false` (API-key mode / no token) so this stays a cheap gate.
        usage_limits: cfg.agent.usage_limits && cfg.agent.backend.startsWith('claude'),
        activeProject: !!activeProjectId(cfg),
      };
    },
    async getUsageLimits(): Promise<ClaudeUsageLimits> {
      const cfg = orchestrator.currentConfig();
      if (!cfg.agent.usage_limits) return { available: false, reason: 'disabled' };
      if (!cfg.agent.backend.startsWith('claude')) return { available: false, reason: 'backend' };
      const now = Date.now();
      if (usageLimitsCache && now - usageLimitsCache.at < USAGE_LIMITS_TTL_MS)
        return usageLimitsCache.value;
      const value = await fetchUsageLimits();
      usageLimitsCache = { at: now, value };
      return value;
    },
    listSessions: () => orchestrator.listSessions(),
    terminate: (id) => orchestrator.terminate(id),
    terminateAll: () => orchestrator.terminateAll(),
    unblock: (id) => orchestrator.unblock(id),
    // ---- plan mode ----
    getPlan: (id) => orchestrator.getPlan(id),
    startPlan: (id, customInstructions) => orchestrator.startPlan(id, customInstructions),
    answerPlanQuestion: (id, askId, answers) => orchestrator.answerPlanQuestion(id, askId, answers),
    revisePlan: (id) => orchestrator.revisePlan(id),
    editPlan: (id, markdown) => orchestrator.editPlan(id, markdown),
    addPlanComment: (id, anchor, body) => orchestrator.addPlanComment(id, anchor, body),
    resolvePlanComment: (id, commentId, resolved) =>
      orchestrator.resolvePlanComment(id, commentId, resolved),
    approvePlan: (id) => orchestrator.approvePlan(id),
    cancelPlan: (id) => orchestrator.cancelPlan(id),
    subscribeLogs: (id, cb) => orchestrator.subscribeLogs(id, cb),
    subscribeBoard: (cb) => orchestrator.subscribeBoard(cb),

    async listProjects(): Promise<ProjectsDTO> {
      const cfg = orchestrator.currentConfig();
      const t = cfg.tracker;
      // No implicit "default": an unset project_id means no active project.
      const active = activeProjectId(cfg);
      const byId = new Map<string, ProjectDTO>();
      for (const p of cfg.projects) {
        byId.set(p.project_id, {
          project_id: p.project_id,
          name: p.name,
          identifier: p.identifier ?? null,
          repo: p.repo,
          repo_path: expandHome(p.repo),
          registered: true,
          active: p.project_id === active,
        });
      }
      // Surface any scaffolded-but-unregistered project dirs under the file store's data_root.
      if (t.kind === 'file' && t.data_root) {
        for (const key of await listProjectKeys(t.data_root)) {
          if (byId.has(key)) continue;
          byId.set(key, {
            project_id: key,
            name: key,
            identifier: null,
            repo: null,
            repo_path: null,
            registered: false,
            active: key === active,
          });
        }
      }
      if (active && !byId.has(active)) {
        byId.set(active, {
          project_id: active,
          name: active,
          identifier: null,
          repo: cfg.workspace.repo ?? null,
          repo_path: expandHome(cfg.workspace.repo),
          registered: false,
          active: true,
        });
      }
      return { projects: [...byId.values()], active_project_id: active };
    },

    async switchProject(projectId: string): Promise<{ switched: boolean }> {
      const st = requireStore();
      const entry = orchestrator.currentConfig().projects.find((p) => p.project_id === projectId);
      if (!entry) {
        throw new Error(`project ${projectId} is not registered; create or register it first`);
      }
      const mutate = (raw: Record<string, unknown>): void => {
        const tracker = (raw['tracker'] ??= {}) as Record<string, unknown>;
        tracker['project_id'] = entry.project_id;
        const workspace = (raw['workspace'] ??= {}) as Record<string, unknown>;
        workspace['repo'] = entry.repo;
      };
      const next = st.composeConfig(mutate); // validate before any teardown
      const res = await orchestrator.switchProject(next); // atomic; throws on bad repo
      await st.persist(mutate); // commit only after the live switch succeeds
      return res;
    },

    async createProject(input: CreateProjectInput): Promise<ProjectDTO> {
      const st = requireStore();
      const cfg = orchestrator.currentConfig();
      const t = cfg.tracker;
      if (t.kind !== 'file' || !t.data_root)
        throw new Error('project creation requires a file tracker');
      const dataRoot = t.data_root;
      // Mint a unique, path-safe project key from the name.
      const taken = new Set([
        ...cfg.projects.map((p) => p.project_id),
        ...(await listProjectKeys(dataRoot)),
      ]);
      const base = slugify(input.name);
      let key = base;
      for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
      const entry: ProjectEntry = {
        name: input.name,
        project_id: key,
        repo: input.repo,
        identifier: input.identifier,
      };
      const mutate = (raw: Record<string, unknown>): void => {
        const list = Array.isArray(raw['projects']) ? (raw['projects'] as unknown[]) : [];
        list.push(entry);
        raw['projects'] = list;
      };
      // Validate the registry change BEFORE scaffolding so bad input can't orphan a project dir.
      st.composeConfig(mutate);
      // Scaffold the on-disk project (seed states from the configured workflow).
      await scaffoldProject({
        dataRoot,
        projectKey: key,
        seed: {
          identifier: input.identifier,
          states: seedStates(t.backlog_state, t.active_states, t.review_state, t.terminal_states),
        },
      });
      let snap;
      try {
        snap = await st.persist(mutate);
      } catch (e) {
        // Writing the registry failed after scaffolding — remove the orphaned dir before surfacing.
        await rm(path.join(dataRoot, 'projects', key), { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw e;
      }
      orchestrator.applyConfig(snap.config); // make the new registry entry visible immediately
      return {
        project_id: key,
        name: input.name,
        identifier: input.identifier,
        repo: input.repo,
        repo_path: expandHome(input.repo),
        registered: true,
        active: false,
      };
    },

    async updateProject(projectId: string, input: UpdateProjectInput): Promise<ProjectDTO> {
      const st = requireStore();
      const cfg = orchestrator.currentConfig();
      const entry = cfg.projects.find((p) => p.project_id === projectId);
      if (!entry) throw new Error(`project ${projectId} is not registered; create it first`);
      const active = activeProjectId(cfg);
      const repoChanged = input.repo !== undefined && input.repo !== entry.repo;
      const mutate = (raw: Record<string, unknown>): void => {
        const list = Array.isArray(raw['projects'])
          ? (raw['projects'] as Array<Record<string, unknown>>)
          : [];
        for (const p of list) {
          if (p['project_id'] !== projectId) continue;
          if (input.name !== undefined) p['name'] = input.name;
          if (input.repo !== undefined) p['repo'] = input.repo;
        }
        raw['projects'] = list;
        // Re-pointing the ACTIVE project must also move the live workspace.repo so the switch re-inits there.
        if (projectId === active && input.repo !== undefined) {
          const workspace = (raw['workspace'] ??= {}) as Record<string, unknown>;
          workspace['repo'] = input.repo;
        }
      };
      if (projectId === active && repoChanged) {
        const next = st.composeConfig(mutate); // validate before any teardown
        await orchestrator.switchProject(next); // atomic re-init at the new repo
        await st.persist(mutate); // commit only after the live switch succeeds
      } else {
        const snap = await st.persist(mutate);
        orchestrator.applyConfig(snap.config);
      }
      const repo = input.repo ?? entry.repo;
      return {
        project_id: projectId,
        name: input.name ?? entry.name,
        identifier: entry.identifier ?? null,
        repo,
        repo_path: expandHome(repo),
        registered: true,
        active: projectId === active,
      };
    },

    async removeProject(projectId: string): Promise<{ removed: boolean }> {
      const st = requireStore();
      const cfg = orchestrator.currentConfig();
      if (projectId === activeProjectId(cfg))
        throw new Error('cannot remove the active project; switch to another project first');
      if (!cfg.projects.some((p) => p.project_id === projectId))
        throw new Error(`project ${projectId} is not registered`);
      // Drop from the registry only — the on-disk <data_root>/projects/<id> dir is kept (it reappears
      // as an unregistered project and can be re-added later).
      const snap = await st.persist((raw) => {
        const list = Array.isArray(raw['projects']) ? (raw['projects'] as unknown[]) : [];
        raw['projects'] = list.filter(
          (p) => (p as { project_id?: string }).project_id !== projectId,
        );
      });
      orchestrator.applyConfig(snap.config);
      return { removed: true };
    },

    async closeProject(): Promise<{ closed: boolean }> {
      const st = requireStore();
      if (!activeProjectId(orchestrator.currentConfig())) return { closed: true };
      // Unset tracker.project_id → the tracker factory builds an inert NullTracker (no project,
      // nothing dispatched, no dirs created). The dashboard then shows the create/open prompt.
      const mutate = (raw: Record<string, unknown>): void => {
        const tracker = (raw['tracker'] ??= {}) as Record<string, unknown>;
        delete tracker['project_id'];
      };
      const next = st.composeConfig(mutate); // validate before any teardown
      await orchestrator.switchProject(next); // atomic; rebuilds tracker as NullTracker
      await st.persist(mutate); // commit only after the live switch succeeds
      return { closed: true };
    },

    getSettings(): SettingsDTO {
      const c = orchestrator.currentConfig();
      return {
        agent: {
          backend: c.agent.backend,
          model: c.agent.model ?? null,
          permission_mode: c.agent.permission_mode,
          max_turns: c.agent.max_turns,
          max_continuations: c.agent.max_continuations,
          max_concurrent_agents: c.agent.max_concurrent_agents,
          max_retry_backoff_ms: c.agent.max_retry_backoff_ms,
          turn_timeout_ms: c.agent.turn_timeout_ms,
          stall_timeout_ms: c.agent.stall_timeout_ms,
          tmux: c.agent.tmux,
          max_budget_usd: c.agent.max_budget_usd ?? null,
        },
        polling: { interval_ms: c.polling.interval_ms },
        workspace: {
          branch_prefix: c.workspace.branch_prefix,
          mode: c.workspace.mode,
          merge_on_accept: c.workspace.merge_on_accept,
        },
        plan: { qa_mode: c.plan.qa_mode },
      };
    },

    async updateSettings(patch: SettingsPatch): Promise<void> {
      const st = requireStore();
      const mutate = (raw: Record<string, unknown>): void => {
        if (patch.agent) {
          const agent = (raw['agent'] ??= {}) as Record<string, unknown>;
          for (const [k, v] of Object.entries(patch.agent)) {
            if (v === undefined) continue;
            if (v === null) delete agent[k];
            else agent[k] = v;
          }
        }
        if (patch.polling?.interval_ms !== undefined) {
          const polling = (raw['polling'] ??= {}) as Record<string, unknown>;
          polling['interval_ms'] = patch.polling.interval_ms;
        }
        if (patch.workspace) {
          const workspace = (raw['workspace'] ??= {}) as Record<string, unknown>;
          if (patch.workspace.branch_prefix !== undefined)
            workspace['branch_prefix'] = patch.workspace.branch_prefix;
          if (patch.workspace.mode !== undefined) workspace['mode'] = patch.workspace.mode;
          if (patch.workspace.merge_on_accept !== undefined)
            workspace['merge_on_accept'] = patch.workspace.merge_on_accept;
        }
        if (patch.plan?.qa_mode !== undefined) {
          const plan = (raw['plan'] ??= {}) as Record<string, unknown>;
          plan['qa_mode'] = patch.plan.qa_mode;
        }
      };
      const snap = await st.persist(mutate); // persist() validates (zod) before writing
      // applySettings rebuilds the workspace manager when mode/repo/root change (single_dir ⇄ worktree).
      await orchestrator.applySettings(snap.config);
    },

    async listStates(): Promise<BoardStateDTO[]> {
      const tracker = orchestrator.currentTracker();
      if (!supportsBoard(tracker)) throw new Error('tracker does not support board reads');
      return tracker.listWorkflowStates();
    },

    async listLabels(): Promise<LabelInfo[]> {
      const tracker = orchestrator.currentTracker();
      if (!supportsBoard(tracker)) throw new Error('tracker does not support board reads');
      return tracker.listLabels();
    },

    async getBoard(): Promise<BoardData> {
      const tracker = orchestrator.currentTracker();
      if (!supportsBoard(tracker)) throw new Error('tracker does not support board reads');
      const [issues, states] = await Promise.all([
        tracker.fetchAllIssues(),
        tracker.listWorkflowStates(),
      ]);
      const snap = orchestrator.snapshot();
      const columns: Record<string, BoardIssueDTO[]> = {};
      for (const s of states) columns[s.name] = [];
      for (const i of issues) {
        const dto: BoardIssueDTO = {
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          state: i.state,
          priority: i.priority,
          labels: i.labels,
          url: i.url,
          status: statusOf(i.id, snap),
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          plan_status: i.plan?.status ?? null,
        };
        (columns[i.state] ??= []).push(dto);
      }
      return { states, columns };
    },

    async getIssueDetail(id: string): Promise<IssueDetailDTO | null> {
      const tracker = orchestrator.currentTracker();
      if (!supportsBoard(tracker)) throw new Error('tracker does not support board reads');
      const issue = (await tracker.fetchAllIssues()).find((i) => i.id === id);
      if (!issue) return null;
      const [activity, comments] = supportsActivity(tracker)
        ? await Promise.all([tracker.fetchActivity(id), tracker.fetchComments(id)])
        : [[], []];
      // single_dir: the agent works in workspace.repo directly. worktree: mirrors
      // WorkspaceManager.createForIssue (<workspace.root>/<sanitized identifier>). Surfaced only when
      // the path exists so "Open in VS Code" hides for never-run tickets.
      const wcfg = orchestrator.currentConfig().workspace;
      const worktree =
        wcfg.mode === 'single_dir'
          ? (wcfg.repo ?? null)
          : path.join(wcfg.root, sanitizeIdentifier(issue.identifier));
      const snap = orchestrator.snapshot();
      // Prefer live per-run counts while the task is running; fall back to the persisted total.
      const live = snap.running.find((r) => r.issue_id === issue.id)?.tokens;
      const persisted = issue.usage;
      const usage = live
        ? {
            input_tokens: live.input_tokens,
            output_tokens: live.output_tokens,
            total_tokens: live.total_tokens,
            cost_usd: live.cost_usd,
          }
        : persisted
          ? {
              input_tokens: persisted.inputTokens,
              output_tokens: persisted.outputTokens,
              total_tokens: persisted.totalTokens,
              cost_usd: persisted.costUsd ?? null,
            }
          : null;
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        state: issue.state,
        priority: issue.priority,
        labels: issue.labels,
        url: issue.url,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        status: statusOf(issue.id, snap),
        activity,
        comments,
        attachments: issue.attachments ?? [],
        model: issue.model ?? null,
        effort: issue.effort ?? null,
        usage,
        worktree_path: worktree && existsSync(worktree) ? worktree : null,
        plan: issue.plan ?? null,
      };
    },

    async createTicket(input: CreateTicketInput): Promise<{ id: string; identifier: string }> {
      const tracker = orchestrator.currentTracker();
      if (!supportsIssueCreation(tracker))
        throw new Error('tracker does not support issue creation');
      const attachments: Array<{ url: string; title: string }> = [];
      if (input.files?.length) {
        if (!supportsIssueWriter(tracker)) throw new Error('tracker does not support file upload');
        for (const f of input.files) {
          const { assetUrl } = await tracker.uploadFile(f);
          attachments.push({ url: assetUrl, title: f.filename });
        }
      }
      const issue = await tracker.createIssue({
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.stateId !== undefined ? { stateId: input.stateId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      // Proper attachment records in addition to the embedded markdown.
      if (supportsIssueWriter(tracker)) {
        for (const a of attachments) await tracker.attachToIssue(issue.id, a.url, a.title);
      }
      return { id: issue.id, identifier: issue.identifier };
    },

    async moveIssue(issueId: string, stateId: string): Promise<void> {
      const tracker = orchestrator.currentTracker();
      if (!supportsIssueWriter(tracker)) throw new Error('tracker does not support state changes');
      await tracker.updateIssueState(issueId, stateId);
      orchestrator.resume(issueId);
      // If the operator moved an untracked ticket to a terminal state (e.g. Accept → Done on a parked
      // review ticket), integrate (worktree-mode merge) + clean up — reconcile only sees tracked issues.
      await orchestrator.onExternalMove(issueId);
    },

    async updateIssue(issueId: string, edit: IssueEditInput): Promise<void> {
      const tracker = orchestrator.currentTracker();
      if (!supportsIssueWriter(tracker)) throw new Error('tracker does not support edits');
      const patch: IssuePatch = {};
      if (edit.title !== undefined) patch.title = edit.title;
      if (edit.description !== undefined) patch.description = edit.description;
      if (edit.priority !== undefined) patch.priority = edit.priority;
      if (edit.labels !== undefined) {
        // Resolve operator-supplied label names to ids; keep unknown names as-is so new labels (e.g.
        // the `rework` badge) persist — the file/memory stores use the label name as its id.
        const infos = supportsBoard(tracker) ? await tracker.listLabels() : [];
        const byName = new Map(infos.map((l) => [l.name.toLowerCase(), l.id]));
        patch.labelIds = edit.labels.map((n) => byName.get(n.toLowerCase()) ?? n);
      }
      if (edit.model !== undefined) patch.model = edit.model;
      if (edit.effort !== undefined) patch.effort = edit.effort;
      await tracker.updateIssue(issueId, patch);
    },

    async addComment(issueId: string, body: string): Promise<void> {
      const tracker = orchestrator.currentTracker();
      if (!supportsIssueWriter(tracker)) throw new Error('tracker does not support comments');
      await tracker.addComment(issueId, body);
    },

    async deleteIssue(issueId: string): Promise<{ deleted: boolean }> {
      const tracker = orchestrator.currentTracker();
      if (!supportsIssueRemoval(tracker)) throw new Error('tracker does not support deletion');
      // Don't delete a ticket with a live agent — the operator must terminate it first.
      if (orchestrator.snapshot().running.some((r) => r.issue_id === issueId))
        throw new Error('cannot delete a running issue; terminate the agent first');
      await tracker.deleteIssue(issueId);
      return { deleted: true };
    },

    async addAttachment(
      issueId: string,
      file: CreateTicketFile,
    ): Promise<{ url: string; title: string }> {
      const tracker = orchestrator.currentTracker();
      if (!supportsIssueWriter(tracker)) throw new Error('tracker does not support attachments');
      const { assetUrl } = await tracker.uploadFile(file);
      await tracker.attachToIssue(issueId, assetUrl, file.filename);
      return { url: assetUrl, title: file.filename };
    },

    async removeAttachment(issueId: string, url: string): Promise<{ removed: boolean }> {
      const tracker = orchestrator.currentTracker();
      if (!supportsIssueRemoval(tracker))
        throw new Error('tracker does not support attachment removal');
      await tracker.detachFromIssue(issueId, url);
      return { removed: true };
    },

    resolveUpload(projectKey: string, rest: string): string | null {
      const t = orchestrator.currentConfig().tracker;
      if (t.kind !== 'file' || !t.data_root) return null;
      if (projectKey.includes('/') || projectKey.includes('\\') || projectKey.includes('..'))
        return null;
      const base = path.join(t.data_root, 'projects', projectKey, 'uploads');
      const abs = path.resolve(base, rest);
      const rel = path.relative(base, abs);
      // Contain to the uploads dir: reject traversal / absolute escapes.
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return abs;
    },
  };
}
