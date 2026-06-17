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
}
export interface SessionInfo {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  tmux_session: string | null;
  pid: number | null;
  started_at: string;
  last_event: string | null;
  turn_count: number;
  workspace_path: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
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
  states: () => fetch('/api/v1/states').then((r) => jsonOrThrow<BoardStateDTO[]>(r)),
  sessions: () =>
    fetch('/api/v1/sessions').then((r) => jsonOrThrow<{ sessions: SessionInfo[] }>(r)),
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
  terminate: (issueId: string) =>
    fetch(`/api/v1/sessions/${encodeURIComponent(issueId)}/terminate`, { method: 'POST' }).then(
      (r) => jsonOrThrow<{ terminated: boolean }>(r),
    ),
  terminateAll: () =>
    fetch('/api/v1/sessions/terminate-all', { method: 'POST' }).then((r) =>
      jsonOrThrow<{ terminated: number }>(r),
    ),
  logStream: (issueId: string) =>
    new EventSource(`/api/v1/sessions/${encodeURIComponent(issueId)}/logs`),
};
