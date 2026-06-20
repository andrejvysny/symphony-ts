import type { IssuePlan, IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type {
  BoardReader,
  CreateIssueInput,
  IssueCreator,
  IssuePatch,
  IssueRemover,
  IssueWriter,
  LabelInfo,
  PlanStore,
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
export class MemoryTracker
  implements Tracker, IssueCreator, BoardReader, IssueWriter, IssueRemover, PlanStore
{
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

  async listLabels(): Promise<LabelInfo[]> {
    const names = new Set<string>();
    for (const i of this.issues.values()) for (const l of i.labels) names.add(l);
    return [...names].map((name) => ({ id: name, name }));
  }

  // ---- IssueWriter ----
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`issue ${issueId} not found`);
    issue.state = stateId; // stateId === state name in memory
  }

  async updateIssue(issueId: string, patch: IssuePatch): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`issue ${issueId} not found`);
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.description !== undefined) issue.description = patch.description;
    if (patch.priority !== undefined) issue.priority = patch.priority;
    if (patch.labelIds !== undefined) issue.labels = patch.labelIds; // id === name in memory
    if (patch.model !== undefined) {
      if (patch.model === null) delete issue.model;
      else issue.model = patch.model;
    }
    if (patch.effort !== undefined) {
      if (patch.effort === null) delete issue.effort;
      else issue.effort = patch.effort;
    }
    if (patch.usage !== undefined) issue.usage = patch.usage;
  }

  async addComment(issueId: string, body: string): Promise<void> {
    this.comments.push({ issueId, body });
  }

  async uploadFile(input: UploadInput): Promise<{ assetUrl: string }> {
    return { assetUrl: `memory://asset/${encodeURIComponent(input.filename)}` };
  }

  async attachToIssue(issueId: string, url: string, title?: string): Promise<void> {
    this.attachments.push({ issueId, url, title: title ?? url });
    const issue = this.issues.get(issueId);
    if (issue) issue.attachments = [...(issue.attachments ?? []), { url, title: title ?? url }];
  }

  // ---- PlanStore ----
  async updatePlan(
    issueId: string,
    fn: (prev: IssuePlan | undefined) => IssuePlan,
  ): Promise<IssuePlan> {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`issue ${issueId} not found`);
    const next = fn(issue.plan);
    issue.plan = next;
    return next;
  }

  async getPlan(issueId: string): Promise<IssuePlan | null> {
    return this.issues.get(issueId)?.plan ?? null;
  }

  // ---- IssueRemover ----
  async detachFromIssue(issueId: string, url: string): Promise<void> {
    const idx = this.attachments.findIndex((a) => a.issueId === issueId && a.url === url);
    if (idx >= 0) this.attachments.splice(idx, 1);
    const issue = this.issues.get(issueId);
    if (issue?.attachments) issue.attachments = issue.attachments.filter((a) => a.url !== url);
  }

  async deleteIssue(issueId: string): Promise<void> {
    if (!this.issues.delete(issueId)) throw new Error(`issue ${issueId} not found`);
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
