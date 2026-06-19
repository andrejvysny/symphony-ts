import type { IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type { BoardReader, LabelInfo, Tracker, WorkflowStateInfo } from '../tracker.js';

/**
 * Inert tracker used when there is **no active project** (`tracker.project_id` unset). Implements the
 * read + board surface so the orchestrator idles (no candidates) and the dashboard renders cleanly,
 * but it touches NO disk and supports no writes/creation — so nothing (e.g. a "default" project dir)
 * is ever auto-created. Switching to a real project rebuilds the tracker via the runtime factory.
 */
export class NullTracker implements Tracker, BoardReader {
  readonly kind = 'none';

  async fetchCandidateIssues(): Promise<NormalizedIssue[]> {
    return [];
  }
  async fetchIssuesByStates(): Promise<NormalizedIssue[]> {
    return [];
  }
  async fetchIssueStatesByIds(): Promise<IssueStateRef[]> {
    return [];
  }

  // ---- BoardReader (empty board so the dashboard's board fetch resolves instead of erroring) ----
  async fetchAllIssues(): Promise<NormalizedIssue[]> {
    return [];
  }
  async listWorkflowStates(): Promise<WorkflowStateInfo[]> {
    return [];
  }
  async listLabels(): Promise<LabelInfo[]> {
    return [];
  }
}
