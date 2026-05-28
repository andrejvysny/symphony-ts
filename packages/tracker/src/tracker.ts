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

/** Optional write capability — used by the `symphony ticket create` command only. */
export interface IssueCreator {
  createIssue(input: {
    title: string;
    description?: string;
    stateName?: string;
    priority?: number;
  }): Promise<NormalizedIssue>;
}

export function supportsIssueCreation(t: Tracker): t is Tracker & IssueCreator {
  return typeof (t as Partial<IssueCreator>).createIssue === 'function';
}
