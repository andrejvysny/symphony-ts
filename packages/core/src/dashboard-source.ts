import type { AgentEvent } from '@symphony/agent-backends';
import {
  supportsBoard,
  supportsIssueCreation,
  supportsIssueWriter,
  type Tracker,
} from '@symphony/tracker';
import type {
  Orchestrator,
  OrchestratorSnapshot,
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
}

/** The capability surface the dashboard consumes. */
export interface DashboardSource {
  snapshot(): OrchestratorSnapshot;
  findIssue(identifier: string): unknown;
  requestRefresh(): Promise<{ coalesced: boolean }>;
  capabilities(): { board: boolean; write: boolean };
  getBoard(): Promise<BoardData>;
  listStates(): Promise<BoardStateDTO[]>;
  createTicket(input: CreateTicketInput): Promise<{ id: string; identifier: string }>;
  moveIssue(issueId: string, stateId: string): Promise<void>;
  listSessions(): SessionInfo[];
  terminate(issueId: string): Promise<{ terminated: boolean }>;
  terminateAll(): Promise<{ terminated: number }>;
  subscribeLogs(issueId: string, cb: (ev: AgentEvent) => void): () => void;
}

/** Build the dashboard source by wiring the orchestrator + tracker (operator path). */
export function buildDashboardSource(
  orchestrator: Orchestrator,
  tracker: Tracker,
): DashboardSource {
  const board = supportsBoard(tracker);
  const writer = supportsIssueWriter(tracker);
  const creator = supportsIssueCreation(tracker);

  function statusOf(id: string, snap: OrchestratorSnapshot): IssueStatus {
    if (snap.running.some((r) => r.issue_id === id)) return 'running';
    if (snap.blocked.some((b) => b.issue_id === id)) return 'blocked';
    if (snap.retrying.some((r) => r.issue_id === id)) return 'retrying';
    if (snap.paused.includes(id)) return 'paused';
    return 'idle';
  }

  return {
    snapshot: () => orchestrator.snapshot(),
    findIssue: (identifier) => orchestrator.findIssue(identifier),
    requestRefresh: () => orchestrator.requestRefresh(),
    capabilities: () => ({ board, write: writer && creator }),
    listSessions: () => orchestrator.listSessions(),
    terminate: (id) => orchestrator.terminate(id),
    terminateAll: () => orchestrator.terminateAll(),
    subscribeLogs: (id, cb) => orchestrator.subscribeLogs(id, cb),

    async listStates(): Promise<BoardStateDTO[]> {
      if (!supportsBoard(tracker)) throw new Error('tracker does not support board reads');
      return tracker.listWorkflowStates();
    },

    async getBoard(): Promise<BoardData> {
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
        };
        (columns[i.state] ??= []).push(dto);
      }
      return { states, columns };
    },

    async createTicket(input: CreateTicketInput): Promise<{ id: string; identifier: string }> {
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
        ...(attachments.length ? { attachments } : {}),
      });
      // Proper attachment records (idempotent on Linear) in addition to the embedded markdown.
      if (supportsIssueWriter(tracker)) {
        for (const a of attachments) await tracker.attachToIssue(issue.id, a.url, a.title);
      }
      return { id: issue.id, identifier: issue.identifier };
    },

    async moveIssue(issueId: string, stateId: string): Promise<void> {
      if (!supportsIssueWriter(tracker)) throw new Error('tracker does not support state changes');
      await tracker.updateIssueState(issueId, stateId);
      orchestrator.resume(issueId);
    },
  };
}
