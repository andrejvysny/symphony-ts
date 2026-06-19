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
  state: string;
  branchName: string | null;
  url: string | null;
  /** Always lowercased. */
  labels: string[];
  blockedBy: Blocker[];
  createdAt: string | null;
  updatedAt: string | null;
  /** Attachment records (asset url + title) persisted on the issue; omitted when none. */
  attachments?: Array<{ url: string; title: string }>;
  /** Per-task agent model override (e.g. `claude-opus-4-8`); falls back to `agent.model`. */
  model?: string;
  /** Per-task reasoning-effort override; falls back to `agent.effort`. */
  effort?: AgentEffort;
  /** Cumulative token/cost usage accrued by the agent on this task; omitted when none. */
  usage?: IssueUsage;
}

/** Minimal issue identity returned by state-refresh reads. */
export interface IssueStateRef {
  id: string;
  identifier: string;
  state: string;
}
