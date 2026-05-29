import type { IssueStateRef, NormalizedIssue } from '@symphony/shared';

/**
 * Issue-tracker boundary (SPEC §11.5). The orchestrator only ever READS through
 * this interface; ticket mutations are performed by the coding agent via tools.
 * `createIssue` is an optional write used solely by the `ticket create` CLI command.
 */
export interface Tracker {
  readonly kind: string;

  /** Issues in active states for the configured project. */
  fetchCandidateIssues(): Promise<NormalizedIssue[]>;

  /** Issues currently in any of the given states (used for startup cleanup). */
  fetchIssuesByStates(states: string[]): Promise<NormalizedIssue[]>;

  /** Current state for each id (used for active reconciliation). Missing ids are omitted. */
  fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]>;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  stateName?: string;
  stateId?: string;
  priority?: number;
  /** Asset links appended to the description as markdown (from uploadFile). */
  attachments?: Array<{ url: string; title: string }>;
}

/** Optional write capability — used by the `ticket create` command and the dashboard. */
export interface IssueCreator {
  createIssue(input: CreateIssueInput): Promise<NormalizedIssue>;
}

export function supportsIssueCreation(t: Tracker): t is Tracker & IssueCreator {
  return typeof (t as Partial<IssueCreator>).createIssue === 'function';
}

/** A workflow state (kanban column). */
export interface WorkflowStateInfo {
  id: string;
  name: string;
  /** triage | backlog | unstarted | started | completed | canceled */
  type: string;
  position: number;
  color?: string;
}

/** Read the full board (all issues + the workflow states) — operator/dashboard path. */
export interface BoardReader {
  fetchAllIssues(): Promise<NormalizedIssue[]>;
  listWorkflowStates(): Promise<WorkflowStateInfo[]>;
}

export function supportsBoard(t: Tracker): t is Tracker & BoardReader {
  const b = t as Partial<BoardReader>;
  return typeof b.fetchAllIssues === 'function' && typeof b.listWorkflowStates === 'function';
}

export interface UploadInput {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Operator write capability (state moves, comments, attachments) — dashboard path. */
export interface IssueWriter {
  updateIssueState(issueId: string, stateId: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  /** Upload a file to the tracker; returns the permanent asset URL. */
  uploadFile(input: UploadInput): Promise<{ assetUrl: string }>;
  attachToIssue(issueId: string, url: string, title?: string): Promise<void>;
}

export function supportsIssueWriter(t: Tracker): t is Tracker & IssueWriter {
  const w = t as Partial<IssueWriter>;
  return typeof w.updateIssueState === 'function' && typeof w.uploadFile === 'function';
}
