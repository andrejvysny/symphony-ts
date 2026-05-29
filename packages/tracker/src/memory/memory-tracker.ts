import type { IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type {
  BoardReader,
  CreateIssueInput,
  IssueCreator,
  IssueWriter,
  Tracker,
  UploadInput,
  WorkflowStateInfo,
} from '../tracker.js';

export interface MemoryTrackerOptions {
  issues?: NormalizedIssue[];
  activeStates?: string[];
  terminalStates?: string[];
  /** Explicit board columns; synthesized from active+terminal states when omitted. */
  states?: WorkflowStateInfo[];
}

let seq = 0;

function synthStates(active: string[], terminal: string[]): WorkflowStateInfo[] {
  const out: WorkflowStateInfo[] = [];
  let pos = 0;
  const typeFor = (name: string, terminalState: boolean): string => {
    const n = name.toLowerCase();
    if (terminalState)
      return n.includes('cancel') || n.includes('duplicate') ? 'canceled' : 'completed';
    if (n === 'backlog') return 'backlog';
    if (n === 'todo') return 'unstarted';
    return 'started';
  };
  for (const name of active)
    out.push({ id: name, name, type: typeFor(name, false), position: pos++ });
  for (const name of terminal)
    out.push({ id: name, name, type: typeFor(name, true), position: pos++ });
  return out;
}

/**
 * In-memory tracker for tests and the offline demo. Implements the full read +
 * board + write surface (stateId === state name in memory). Supports scriptable
 * state transitions so a test can move an issue Todo → In Progress → Done.
 */
export class MemoryTracker implements Tracker, IssueCreator, BoardReader, IssueWriter {
  readonly kind = 'memory';
  private readonly issues = new Map<string, NormalizedIssue>();
  private readonly activeStates: Set<string>;
  private readonly states: WorkflowStateInfo[];
  readonly comments: Array<{ issueId: string; body: string }> = [];
  readonly attachments: Array<{ issueId: string; url: string; title: string }> = [];

  constructor(opts: MemoryTrackerOptions = {}) {
    for (const issue of opts.issues ?? []) this.issues.set(issue.id, { ...issue });
    const active = opts.activeStates ?? ['Todo', 'In Progress'];
    const terminal = opts.terminalStates ?? ['Done', 'Canceled'];
    this.activeStates = new Set(active);
    this.states = opts.states ?? synthStates(active, terminal);
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

  // ---- BoardReader ----
  async fetchAllIssues(): Promise<NormalizedIssue[]> {
    return [...this.issues.values()].map((i) => ({ ...i }));
  }

  async listWorkflowStates(): Promise<WorkflowStateInfo[]> {
    return this.states.map((s) => ({ ...s }));
  }

  // ---- IssueWriter ----
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`issue ${issueId} not found`);
    issue.state = stateId; // stateId === state name in memory
  }

  async addComment(issueId: string, body: string): Promise<void> {
    this.comments.push({ issueId, body });
  }

  async uploadFile(input: UploadInput): Promise<{ assetUrl: string }> {
    return { assetUrl: `memory://asset/${encodeURIComponent(input.filename)}` };
  }

  async attachToIssue(issueId: string, url: string, title?: string): Promise<void> {
    this.attachments.push({ issueId, url, title: title ?? url });
  }

  // ---- IssueCreator ----
  async createIssue(input: CreateIssueInput): Promise<NormalizedIssue> {
    seq += 1;
    const n = seq;
    let description = input.description ?? null;
    if (input.attachments?.length) {
      const md = input.attachments.map((a) => `![${a.title}](${a.url})`).join('\n');
      description = description ? `${description}\n\n${md}` : md;
    }
    const issue: NormalizedIssue = {
      id: `mem-${n}`,
      identifier: `MEM-${n}`,
      title: input.title,
      description,
      priority: input.priority ?? null,
      state: input.stateName ?? input.stateId ?? 'Todo',
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
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
