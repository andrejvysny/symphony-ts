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
}
export interface BoardData {
  states: BoardStateDTO[];
  columns: Record<string, BoardIssueDTO[]>;
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
  /** Token/cost usage for the task: live while running, else persisted; null when none. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number | null;
  } | null;
  /** Absolute worktree path when it exists on disk (for "Open in VS Code"); null otherwise. */
  worktree_path: string | null;
}
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}
export interface SessionInfo {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  tmux_session: string | null;
  pid: number | null;
  backend: string;
  started_at: string;
  last_event: string | null;
  last_event_at: string | null;
  last_action: string | null;
  turn_count: number;
  continuation_count: number;
  workspace_path: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
  /** The agent's own plan: its latest TodoWrite todo list (null until it writes one). */
  todos: TodoItem[] | null;
  /** Compact progress over `todos` (completed/total); null when the agent has no todos. */
  todo_progress: { done: number; total: number } | null;
}

export interface RuntimeInfo {
  backend: string;
  branch_prefix: string;
  max_concurrent_agents: number;
  poll_interval_ms: number;
  max_turns: number;
  max_continuations: number;
  stall_timeout_ms: number;
  /** Workflow state classification (state names) for resolving review/rework/terminal targets. */
  active_states: string[];
  terminal_states: string[];
  review_state: string;
  backlog_state: string;
  in_progress_state: string;
  workspace_mode: string;
}
export interface LabelInfo {
  id: string;
  name: string;
}
/** Reasoning-effort level for the coding agent (maps to the SDK `effort` option). */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface IssueEdit {
  title?: string;
  description?: string;
  priority?: number | null;
  labels?: string[];
  /** Per-task agent overrides; null clears back to the global agent config. */
  model?: string | null;
  effort?: AgentEffort | null;
}

export interface SnapshotBlocked {
  issue_id: string;
  issue_identifier: string;
  reason: string;
  blocked_at: string;
}
export interface SnapshotRetry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  delay_type: string;
  due_at: string;
  error: string | null;
}
export interface SnapshotMergeFailure {
  issue_id: string;
  issue_identifier: string;
  reason: string;
  at: string;
}
/** Run-wide cumulative token/cost/time totals (named codex_totals for legacy reasons). */
export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  seconds_running: number;
}
export interface StateSnapshot {
  counts: {
    running: number;
    claimed: number;
    blocked: number;
    retrying: number;
    completed: number;
    paused: number;
  };
  paused: string[];
  blocked: SnapshotBlocked[];
  retrying: SnapshotRetry[];
  /** Issues whose auto-merge on accept hit a conflict (worktree mode); branch preserved. */
  merge_failures?: SnapshotMergeFailure[];
  /** Cumulative token/cost/time totals across the run. */
  codex_totals: CodexTotals;
}

export interface Capabilities {
  board: boolean;
  write: boolean;
  projects: boolean;
  settings: boolean;
  /** Top-bar Claude usage-limit gauge is available (Claude backend + opt-in flag). */
  usage_limits: boolean;
  /** A project is active; false → the dashboard shows the create/open prompt instead of the board. */
  activeProject: boolean;
}

/** One Claude subscription usage window (5h / weekly), percent consumed + reset time. */
export interface UsageWindow {
  utilization: number;
  resetsAt: string;
}
export type ClaudeUsageLimits =
  | { available: false; reason: string }
  | {
      available: true;
      fiveHour: UsageWindow;
      sevenDay: UsageWindow;
      sevenDayOpus?: UsageWindow;
      sevenDaySonnet?: UsageWindow;
      fetchedAt: string;
    };

export interface ProjectDTO {
  project_id: string;
  name: string;
  identifier: string | null;
  repo: string | null;
  /** Absolute, ~-expanded repo path for an "open folder" link; null when unknown. */
  repo_path: string | null;
  registered: boolean;
  active: boolean;
}
export interface ProjectsDTO {
  projects: ProjectDTO[];
  active_project_id: string | null;
}

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
}
export interface SettingsPatch {
  agent?: Partial<SettingsDTO['agent']>;
  polling?: { interval_ms?: number };
  workspace?: { branch_prefix?: string; mode?: string; merge_on_accept?: boolean };
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      detail = body.error?.message ?? body.error?.code ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  board: () => fetch('/api/v1/board').then((r) => jsonOrThrow<BoardData>(r)),
  state: () => fetch('/api/v1/state').then((r) => jsonOrThrow<StateSnapshot>(r)),
  meta: () => fetch('/api/v1/meta').then((r) => jsonOrThrow<RuntimeInfo>(r)),
  capabilities: () => fetch('/api/v1/capabilities').then((r) => jsonOrThrow<Capabilities>(r)),
  projects: () => fetch('/api/v1/projects').then((r) => jsonOrThrow<ProjectsDTO>(r)),
  switchProject: (projectId: string) =>
    fetch('/api/v1/projects/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }).then((r) => jsonOrThrow<{ switched: boolean }>(r)),
  createProject: (input: { name: string; identifier: string; repo: string }) =>
    fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => jsonOrThrow<ProjectDTO>(r)),
  updateProject: (projectId: string, patch: { name?: string; repo?: string }) =>
    fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => jsonOrThrow<ProjectDTO>(r)),
  removeProject: (projectId: string) =>
    fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }).then((r) =>
      jsonOrThrow<{ removed: boolean }>(r),
    ),
  closeProject: () =>
    fetch('/api/v1/projects/close', { method: 'POST' }).then((r) =>
      jsonOrThrow<{ closed: boolean }>(r),
    ),
  settings: () => fetch('/api/v1/settings').then((r) => jsonOrThrow<SettingsDTO>(r)),
  updateSettings: (patch: SettingsPatch) =>
    fetch('/api/v1/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  states: () => fetch('/api/v1/states').then((r) => jsonOrThrow<BoardStateDTO[]>(r)),
  labels: () => fetch('/api/v1/labels').then((r) => jsonOrThrow<LabelInfo[]>(r)),
  sessions: () =>
    fetch('/api/v1/sessions').then((r) => jsonOrThrow<{ sessions: SessionInfo[] }>(r)),
  usageLimits: () => fetch('/api/v1/usage-limits').then((r) => jsonOrThrow<ClaudeUsageLimits>(r)),
  createTicket: (form: FormData) =>
    fetch('/api/v1/tickets', { method: 'POST', body: form }).then((r) =>
      jsonOrThrow<{ id: string; identifier: string }>(r),
    ),
  moveIssue: (issueId: string, stateId: string) =>
    fetch(`/api/v1/issues/${encodeURIComponent(issueId)}/state`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stateId }),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  updateIssue: (id: string, edit: IssueEdit) =>
    fetch(`/api/v1/issues/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edit),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  issueDetail: (id: string) =>
    fetch(`/api/v1/issues/${encodeURIComponent(id)}/detail`).then((r) =>
      jsonOrThrow<IssueDetailDTO>(r),
    ),
  addComment: (id: string, body: string) =>
    fetch(`/api/v1/issues/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  deleteIssue: (id: string) =>
    fetch(`/api/v1/issues/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) =>
      jsonOrThrow<{ deleted: boolean }>(r),
    ),
  addAttachment: (id: string, form: FormData) =>
    fetch(`/api/v1/issues/${encodeURIComponent(id)}/attachments`, {
      method: 'POST',
      body: form,
    }).then((r) => jsonOrThrow<{ url: string; title: string }>(r)),
  removeAttachment: (id: string, url: string) =>
    fetch(`/api/v1/issues/${encodeURIComponent(id)}/attachments`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => jsonOrThrow<{ removed: boolean }>(r)),
  terminate: (issueId: string) =>
    fetch(`/api/v1/sessions/${encodeURIComponent(issueId)}/terminate`, { method: 'POST' }).then(
      (r) => jsonOrThrow<{ terminated: boolean }>(r),
    ),
  unblock: (issueId: string) =>
    fetch(`/api/v1/sessions/${encodeURIComponent(issueId)}/unblock`, { method: 'POST' }).then((r) =>
      jsonOrThrow<{ unblocked: boolean }>(r),
    ),
  terminateAll: () =>
    fetch('/api/v1/sessions/terminate-all', { method: 'POST' }).then((r) =>
      jsonOrThrow<{ terminated: number }>(r),
    ),
  /** Poke the orchestrator to poll + dispatch immediately (rate-limited server-side). */
  refresh: () => fetch('/api/v1/refresh', { method: 'POST' }).then((r) => r.ok),
  logStream: (issueId: string) =>
    new EventSource(`/api/v1/sessions/${encodeURIComponent(issueId)}/logs`),
  /** Global board/state change stream — pushes `{type:'board_changed'}` so the UI refetches live. */
  eventStream: () => new EventSource('/api/v1/events'),
};
