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

/** A project label (id + name) for the operator label picker. */
export interface LabelInfo {
  id: string;
  name: string;
}

/** Read the full board (all issues + the workflow states + labels) — operator/dashboard path. */
export interface BoardReader {
  fetchAllIssues(): Promise<NormalizedIssue[]>;
  listWorkflowStates(): Promise<WorkflowStateInfo[]>;
  listLabels(): Promise<LabelInfo[]>;
}

export function supportsBoard(t: Tracker): t is Tracker & BoardReader {
  const b = t as Partial<BoardReader>;
  return (
    typeof b.fetchAllIssues === 'function' &&
    typeof b.listWorkflowStates === 'function' &&
    typeof b.listLabels === 'function'
  );
}

/** Operator edits to an existing issue's metadata (omitted fields are left unchanged). */
export interface IssuePatch {
  title?: string;
  description?: string;
  /** 1=urgent..4=low; null clears priority to "none". */
  priority?: number | null;
  /** Full replacement set of label ids (resolved from names by the dashboard source). */
  labelIds?: string[];
}

export interface UploadInput {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Operator write capability (state moves, edits, comments, attachments) — dashboard path. */
export interface IssueWriter {
  updateIssueState(issueId: string, stateId: string): Promise<void>;
  /** Edit issue metadata (title/description/priority/labels). */
  updateIssue(issueId: string, patch: IssuePatch): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  /** Upload a file to the tracker; returns the permanent asset URL. */
  uploadFile(input: UploadInput): Promise<{ assetUrl: string }>;
  attachToIssue(issueId: string, url: string, title?: string): Promise<void>;
}

export function supportsIssueWriter(t: Tracker): t is Tracker & IssueWriter {
  const w = t as Partial<IssueWriter>;
  return typeof w.updateIssueState === 'function' && typeof w.uploadFile === 'function';
}

/** A single change in an issue's history (created, state move, field edit, …). */
export interface IssueActivity {
  /** ISO timestamp of the change. */
  at: string;
  /** The changed field (e.g. `state`), or null for create/non-field events. */
  field: string | null;
  /** `created` | `updated` | `deleted` | … */
  verb: string;
  oldValue: string | null;
  newValue: string | null;
}

/** A comment on an issue. */
export interface IssueComment {
  at: string;
  /** Plain-text comment body. */
  body: string;
}

/** Read an issue's change history + comments (operator/detail path). */
export interface ActivityReader {
  /** Chronological (oldest-first) change history for an issue. */
  fetchActivity(issueId: string): Promise<IssueActivity[]>;
  /** Chronological (oldest-first) comments for an issue. */
  fetchComments(issueId: string): Promise<IssueComment[]>;
}

export function supportsActivity(t: Tracker): t is Tracker & ActivityReader {
  const a = t as Partial<ActivityReader>;
  return typeof a.fetchActivity === 'function' && typeof a.fetchComments === 'function';
}
