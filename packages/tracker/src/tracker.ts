import type {
  AgentEffort,
  Blocker,
  IssuePlan,
  IssueStateRef,
  IssueUsage,
  NormalizedIssue,
  OrderRun,
} from '@symphony/shared';

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

/**
 * Rewrite each issue's `blockedBy[].state` from the live `id → state` map so the dispatch gate
 * (`blockedByNonTerminal`) always sees a blocker's CURRENT state, not the snapshot taken when the
 * dependency was recorded. A blocker whose id is no longer present (deleted) is dropped — a dangling
 * blocker must never deadlock its dependent. Called by trackers in `fetchCandidateIssues`.
 */
export function refreshBlockerStates(
  issues: NormalizedIssue[],
  stateById: Map<string, string>,
): NormalizedIssue[] {
  return issues.map((i) =>
    i.blockedBy.length === 0
      ? i
      : {
          ...i,
          blockedBy: i.blockedBy
            .filter((b) => stateById.has(b.id))
            .map((b) => ({ ...b, state: stateById.get(b.id) as string })),
        },
  );
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  stateName?: string;
  stateId?: string;
  priority?: number;
  /** Asset links appended to the description as markdown (from uploadFile). */
  attachments?: Array<{ url: string; title: string }>;
  /** Per-task agent overrides (fall back to global agent config). */
  model?: string;
  effort?: AgentEffort;
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
  /** Dispatch sort key (lower = earlier); null clears it (back to unranked). Sequence-written. */
  rank?: number | null;
  /** Full replacement of the issue's blocker set (sequencing dependency edges). Sequence-written. */
  blockedBy?: Blocker[];
  /** Ticket type (bug/feature/…); empty string clears it. */
  type?: string;
  /** Full replacement set of label ids (resolved from names by the dashboard source). */
  labelIds?: string[];
  /** Per-task agent overrides; null clears back to the global agent config. */
  model?: string | null;
  effort?: AgentEffort | null;
  /** Cumulative token/cost usage written by the orchestrator on worker exit. */
  usage?: IssueUsage;
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
  attachToIssue(
    issueId: string,
    url: string,
    title?: string,
    meta?: { size?: number; contentType?: string },
  ): Promise<void>;
}

export function supportsIssueWriter(t: Tracker): t is Tracker & IssueWriter {
  const w = t as Partial<IssueWriter>;
  return typeof w.updateIssueState === 'function' && typeof w.uploadFile === 'function';
}

/** Optional destructive operator writes (delete an issue, remove an attachment) — dashboard path. */
export interface IssueRemover {
  /** Permanently delete an issue (its record + comments/activity). */
  deleteIssue(issueId: string): Promise<void>;
  /** Remove a single attachment record (by asset url) from an issue. */
  detachFromIssue(issueId: string, url: string): Promise<void>;
}

export function supportsIssueRemoval(t: Tracker): t is Tracker & IssueRemover {
  const r = t as Partial<IssueRemover>;
  return typeof r.deleteIssue === 'function' && typeof r.detachFromIssue === 'function';
}

/**
 * Plan-mode persistence: read-modify-write the issue's `plan` artifact under the issue's file lock.
 * Used by the orchestrator's plan run + the dashboard plan endpoints. Separate from {@link IssueWriter}
 * so a tracker can omit it; the plan track is feature-gated on {@link supportsPlanStore}.
 */
export interface PlanStore {
  /** Read-modify-write the plan (receives the current plan or undefined; returns the next plan). */
  updatePlan(issueId: string, fn: (prev: IssuePlan | undefined) => IssuePlan): Promise<IssuePlan>;
  /** The issue's current plan artifact, or null when none. */
  getPlan(issueId: string): Promise<IssuePlan | null>;
}

export function supportsPlanStore(t: Tracker): t is Tracker & PlanStore {
  const p = t as Partial<PlanStore>;
  return typeof p.updatePlan === 'function' && typeof p.getPlan === 'function';
}

/**
 * Sequence-mode persistence: read-modify-write a batch {@link OrderRun} artifact keyed by `runId`
 * (a sequencing run spans many tickets, so it has no per-issue home). Used by the orchestrator's
 * ordering run + the dashboard order endpoints. Feature-gated on {@link supportsOrderStore}.
 */
export interface OrderStore {
  /** Read-modify-write an order run (receives the current run or undefined; returns the next run). */
  updateOrder(runId: string, fn: (prev: OrderRun | undefined) => OrderRun): Promise<OrderRun>;
  /** The order run for `runId`, or null when none. */
  getOrder(runId: string): Promise<OrderRun | null>;
  /** All order runs for the active project (newest-first), for the Sequence tab + resume. */
  listOrders(): Promise<OrderRun[]>;
}

export function supportsOrderStore(t: Tracker): t is Tracker & OrderStore {
  const o = t as Partial<OrderStore>;
  return (
    typeof o.updateOrder === 'function' &&
    typeof o.getOrder === 'function' &&
    typeof o.listOrders === 'function'
  );
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
