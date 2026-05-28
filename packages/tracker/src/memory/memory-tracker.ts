import type { IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type { IssueCreator, Tracker } from '../tracker.js';

export interface MemoryTrackerOptions {
  issues?: NormalizedIssue[];
  activeStates?: string[];
  terminalStates?: string[];
}

let seq = 0;

/**
 * In-memory tracker for tests and demos. Supports scriptable state transitions
 * so an integration test can move an issue Todo → In Progress → Done across ticks.
 */
export class MemoryTracker implements Tracker, IssueCreator {
  readonly kind = 'memory';
  private readonly issues = new Map<string, NormalizedIssue>();
  private readonly activeStates: Set<string>;

  constructor(opts: MemoryTrackerOptions = {}) {
    for (const issue of opts.issues ?? []) this.issues.set(issue.id, { ...issue });
    this.activeStates = new Set(opts.activeStates ?? ['Todo', 'In Progress']);
  }

  async fetchCandidateIssues(): Promise<NormalizedIssue[]> {
    return [...this.issues.values()]
      .filter((i) => this.activeStates.has(i.state))
      .map((i) => ({ ...i }));
  }

  async fetchIssuesByStates(states: string[]): Promise<NormalizedIssue[]> {
    const set = new Set(states);
    return [...this.issues.values()].filter((i) => set.has(i.state)).map((i) => ({ ...i }));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]> {
    const out: IssueStateRef[] = [];
    for (const id of ids) {
      const issue = this.issues.get(id);
      if (issue) out.push({ id: issue.id, identifier: issue.identifier, state: issue.state });
    }
    return out;
  }

  async createIssue(input: {
    title: string;
    description?: string;
    stateName?: string;
    priority?: number;
  }): Promise<NormalizedIssue> {
    seq += 1;
    const n = seq;
    const issue: NormalizedIssue = {
      id: `mem-${n}`,
      identifier: `MEM-${n}`,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? null,
      state: input.stateName ?? 'Todo',
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    };
    this.issues.set(issue.id, issue);
    return { ...issue };
  }

  // ---- test helpers ----
  setState(id: string, state: string): void {
    const issue = this.issues.get(id);
    if (issue) issue.state = state;
  }

  upsert(issue: NormalizedIssue): void {
    this.issues.set(issue.id, { ...issue });
  }

  remove(id: string): void {
    this.issues.delete(id);
  }

  get(id: string): NormalizedIssue | undefined {
    const i = this.issues.get(id);
    return i ? { ...i } : undefined;
  }
}
