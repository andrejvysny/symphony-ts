/** A blocker relation on an issue (from inverse `blocks` relations in the tracker). */
export interface Blocker {
  id: string;
  identifier: string;
  state: string;
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
}

/** Minimal issue identity returned by state-refresh reads. */
export interface IssueStateRef {
  id: string;
  identifier: string;
  state: string;
}
