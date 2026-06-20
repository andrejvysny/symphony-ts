import type { ErrorCategory } from './errors.js';

/** A blocker relation on an issue (from inverse `blocks` relations in the tracker). */
export interface Blocker {
  id: string;
  identifier: string;
  state: string;
}

/** Reasoning-effort level for the coding agent (maps to the SDK `effort` option). */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Cumulative agent token/cost usage for one task, persisted across worker exits
 * (and process restarts) so completed tickets retain their counts. Accumulated by
 * the orchestrator from absolute `usage` events (SPEC §13.5 delta logic).
 */
export interface IssueUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Equivalent API cost in USD (from the SDK's `total_cost_usd`); omitted when unknown. */
  costUsd?: number;
  /** ISO timestamp of the last usage write. */
  updatedAt: string;
}

/** Lifecycle of an issue's plan-mode artifact (read-only planning run + operator review). */
export type PlanStatus = 'planning' | 'awaiting_input' | 'ready' | 'approved' | 'failed';

/** One selectable option in a plan-mode question (mirrors the Claude AskUserQuestion schema). */
export interface PlanQuestionOption {
  label: string;
  description?: string;
  /** Marks the default/suggested choice; rendered as a "Recommended" badge (at most one per question). */
  recommended?: boolean;
}

/** A single question the planning agent asks the operator. */
export interface PlanQuestion {
  id: string;
  /** Short chip/tag label (≤ ~12 chars). */
  header: string;
  question: string;
  options?: PlanQuestionOption[];
  multiSelect: boolean;
}

/** A batch of questions asked in one `symphony_ask` call, plus the operator's answers. */
export interface PlanAsk {
  id: string;
  at: string;
  questions: PlanQuestion[];
  /** Answers keyed by question id: a label/free-text string, or string[] for multiSelect. */
  answers?: Record<string, string | string[]>;
  answeredAt?: string;
}

/** W3C-style text-quote anchor locating an operator comment within the rendered plan markdown. */
export interface PlanTextAnchor {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** An operator (or agent) annotation anchored to a span of the plan markdown. */
export interface PlanComment {
  id: string;
  at: string;
  anchor: PlanTextAnchor;
  body: string;
  resolved: boolean;
  author: 'operator' | 'agent';
}

/**
 * Plan-mode artifact persisted on a Backlog issue: the generated markdown plan, the Q&A history, the
 * live pending question (if any), and operator comments. Written only by the plan run + dashboard;
 * it never moves the ticket's state. Approval copies `markdown` forward into the implementation prompt.
 */
export interface IssuePlan {
  status: PlanStatus;
  /** Latest plan markdown (agent-submitted or user-edited); absent until first submit. */
  markdown?: string;
  /** True when the latest markdown was edited directly by the operator. */
  editedByUser?: boolean;
  /** Agent session to resume for revisions / pause-mode Q&A. */
  sessionId?: string;
  /** The currently-open question batch awaiting an operator answer (null/absent when none). */
  pendingAsk?: PlanAsk | null;
  /** Answered question batches, oldest-first. */
  qa: PlanAsk[];
  /** Operator/agent comments anchored to the plan markdown. */
  comments: PlanComment[];
  /** Bumped on each agent (re)generation of the plan. */
  revision: number;
  /** Why the last plan run failed (operator-facing); set on `status:'failed'`, cleared on (re)start. */
  error?: string;
  /** Classified category of {@link error} (e.g. `auth_required`) for a tailored UI hint. */
  errorCategory?: ErrorCategory;
  createdAt: string;
  updatedAt: string;
}

/** Lifecycle of a Sequence ordering run (read-only analysis of a subset of Backlog tickets). */
export type OrderStatus = 'ordering' | 'awaiting_input' | 'ready' | 'approved' | 'failed';

/** A selected ticket snapshotted into an order run (so the review survives later ticket edits). */
export interface OrderTicketRef {
  id: string;
  identifier: string;
  title: string;
}

/** One ticket's place in the proposed sequence: which selected tickets block it, and why it's here. */
export interface OrderProposalTicket {
  id: string;
  /** Ids of OTHER selected tickets that must be implemented before this one. */
  blockedBy: string[];
  rationale: string;
}

/** The agent's (or operator-edited) proposed ordering for the selected subset. */
export interface OrderProposal {
  /** Selected ticket ids in the recommended implementation order (earliest first). */
  order: string[];
  /** Per-ticket dependency + rationale (one entry per selected ticket). */
  tickets: OrderProposalTicket[];
  summary: string;
  /** True when the operator manually reordered after the agent proposed. */
  editedByUser?: boolean;
}

/**
 * A Sequence ordering run: a read-only agent analysis over a SUBSET of Backlog tickets that proposes
 * the best implementation order + the dependencies between them. Persisted as a batch artifact keyed
 * by `runId` (it spans many tickets, so unlike {@link IssuePlan} it can't live on one issue). The
 * Q&A reuses {@link PlanAsk}. On approve the orchestrator commits `rank` + `blockedBy` onto the
 * tickets and moves them to the entry lane.
 */
export interface OrderRun {
  runId: string;
  status: OrderStatus;
  /** The selected subset, snapshotted at start. */
  selected: OrderTicketRef[];
  /** The operator's free-text steer from the Sequence tab (folded into the agent's first prompt). */
  customInstructions?: string;
  /** The proposed ordering; absent until the agent first submits. */
  proposal?: OrderProposal;
  /** Agent session to resume for re-runs / pause-mode Q&A. */
  sessionId?: string;
  /** The currently-open question batch awaiting an operator answer (null/absent when none). */
  pendingAsk?: PlanAsk | null;
  /** Answered question batches, oldest-first. */
  qa: PlanAsk[];
  /** Bumped on each agent (re)generation of the proposal. */
  revision: number;
  /** On approve: true → tickets were moved to the entry lane (queued); false → committed but kept in Backlog. */
  released?: boolean;
  /** Why the last ordering run failed (operator-facing); set on `status:'failed'`. */
  error?: string;
  /** Classified category of {@link error} for a tailored UI hint. */
  errorCategory?: ErrorCategory;
  createdAt: string;
  updatedAt: string;
}

/**
 * Tracker-neutral issue model. All adapters normalize their native payloads
 * into this shape. Mirrors SPEC §3 (issue model) and the Elixir `Linear.Issue`.
 */
export interface NormalizedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  /**
   * Dispatch sort key (lower = earlier), set by the Sequence feature. Omitted = unranked, which
   * sorts AFTER every ranked ticket (and then by the usual priority/createdAt order). See
   * `sortForDispatch`.
   */
  rank?: number;
  /** Ticket type (bug/feature/task/…); omitted when unset. Renders as a breadcrumb badge. */
  type?: string;
  state: string;
  branchName: string | null;
  url: string | null;
  /** Always lowercased. */
  labels: string[];
  blockedBy: Blocker[];
  createdAt: string | null;
  updatedAt: string | null;
  /** Attachment records persisted on the issue (asset url + title + optional size/contentType); omitted when none. */
  attachments?: Array<{ url: string; title: string; size?: number; contentType?: string }>;
  /** Per-task agent model override (e.g. `claude-opus-4-8`); falls back to `agent.model`. */
  model?: string;
  /** Per-task reasoning-effort override; falls back to `agent.effort`. */
  effort?: AgentEffort;
  /** Cumulative token/cost usage accrued by the agent on this task; omitted when none. */
  usage?: IssueUsage;
  /** Plan-mode artifact (generated plan + Q&A + comments); omitted until a plan run starts. */
  plan?: IssuePlan;
}

/** Minimal issue identity returned by state-refresh reads. */
export interface IssueStateRef {
  id: string;
  identifier: string;
  state: string;
}
