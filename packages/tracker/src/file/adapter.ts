import type { IssuePlan, IssueStateRef, NormalizedIssue } from '@symphony/shared';
import type {
  ActivityReader,
  BoardReader,
  CreateIssueInput,
  IssueActivity,
  IssueComment,
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
import { FileStore, type StoredIssue } from './store.js';

export interface FileTrackerOptions {
  /** Root dir for all projects (absolute; e.g. ~/.symphony). */
  dataRoot: string;
  /** Active project key (directory name under <dataRoot>/projects/). */
  projectKey: string;
  /** Issue id prefix (e.g. "SYM" → SYM-1, SYM-2, …). */
  identifier: string;
  activeStates: string[];
  terminalStates: string[];
  /** Non-active, non-terminal park state seeded as a board lane. */
  reviewState?: string;
  /** Non-active, non-terminal "not yet ready" lane, seeded leftmost (human-only). */
  backlogState?: string;
  onWarn?: (msg: string) => void;
}

/** Workflow-state type inference — mirrors MemoryTracker's `synthStates`. */
function typeFor(name: string, terminalState: boolean): string {
  const n = name.toLowerCase();
  if (terminalState)
    return n.includes('cancel') || n.includes('duplicate') ? 'canceled' : 'completed';
  if (n === 'backlog') return 'backlog';
  if (n === 'todo') return 'unstarted';
  return 'started';
}

/**
 * Seed ordered board states from the configured backlog / active / review / terminal state names.
 * Order (left→right): backlog → active → review → terminal. Empty/undefined names are skipped.
 */
export function seedStates(
  backlog: string | undefined,
  active: string[],
  review: string | undefined,
  terminal: string[],
): WorkflowStateInfo[] {
  const out: WorkflowStateInfo[] = [];
  const seen = new Set<string>();
  let pos = 0;
  const push = (name: string, terminalState: boolean): void => {
    if (name.length === 0 || seen.has(name)) return;
    seen.add(name);
    out.push({ id: name, name, type: typeFor(name, terminalState), position: pos++ });
  };
  if (backlog !== undefined) push(backlog, false);
  for (const name of active) push(name, false);
  if (review !== undefined) push(review, false);
  for (const name of terminal) push(name, true);
  return out;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Local file-backed tracker — a drop-in for the orchestrator/dashboard `Tracker` surface that
 * persists each issue as JSON under `<dataRoot>/projects/<projectKey>/`. State id === state name
 * (like MemoryTracker). The orchestrator only reads; the agent and dashboard write through the
 * single-writer paths (SDK tools in-process, CLI tools via the bridge), all funneling here.
 */
export class FileTracker
  implements
    Tracker,
    IssueCreator,
    BoardReader,
    IssueWriter,
    IssueRemover,
    ActivityReader,
    PlanStore
{
  readonly kind = 'file';
  readonly store: FileStore;
  private readonly activeStates: Set<string>;

  constructor(opts: FileTrackerOptions) {
    this.activeStates = new Set(opts.activeStates);
    this.store = new FileStore({
      dataRoot: opts.dataRoot,
      projectKey: opts.projectKey,
      seed: {
        identifier: opts.identifier,
        states: seedStates(
          opts.backlogState,
          opts.activeStates,
          opts.reviewState,
          opts.terminalStates,
        ),
      },
      ...(opts.onWarn !== undefined ? { onWarn: opts.onWarn } : {}),
    });
  }

  private static toNormalized(s: StoredIssue): NormalizedIssue {
    return {
      id: s.id,
      identifier: s.identifier,
      title: s.title,
      description: s.description,
      priority: s.priority,
      state: s.state,
      branchName: s.branchName,
      url: s.url,
      labels: s.labels,
      blockedBy: s.blockedBy,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      ...(s.attachments !== undefined ? { attachments: s.attachments } : {}),
      ...(s.model !== undefined ? { model: s.model } : {}),
      ...(s.effort !== undefined ? { effort: s.effort } : {}),
      // Map usage explicitly: zod's `.optional()` widens costUsd to `number | undefined`, which
      // exactOptionalPropertyTypes rejects for IssueUsage's `costUsd?: number` when spread directly.
      ...(s.usage !== undefined
        ? {
            usage: {
              inputTokens: s.usage.inputTokens,
              outputTokens: s.usage.outputTokens,
              totalTokens: s.usage.totalTokens,
              updatedAt: s.usage.updatedAt,
              ...(s.usage.costUsd !== undefined ? { costUsd: s.usage.costUsd } : {}),
            },
          }
        : {}),
      // The stored plan is zod-validated against the same shape as IssuePlan; its optional fields infer
      // as `T | undefined` (vs IssuePlan's `T`), so cast at this boundary rather than re-map every field.
      ...(s.plan !== undefined ? { plan: s.plan as IssuePlan } : {}),
    };
  }

  // ---- Tracker (read) ----
  async fetchCandidateIssues(): Promise<NormalizedIssue[]> {
    return (await this.store.listIssues())
      .filter((i) => this.activeStates.has(i.state))
      .map((i) => FileTracker.toNormalized(i));
  }

  async fetchIssuesByStates(states: string[]): Promise<NormalizedIssue[]> {
    const set = new Set(states);
    return (await this.store.listIssues())
      .filter((i) => set.has(i.state))
      .map((i) => FileTracker.toNormalized(i));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<IssueStateRef[]> {
    const out: IssueStateRef[] = [];
    for (const id of ids) {
      const issue = await this.store.readIssue(id);
      if (issue) out.push({ id: issue.id, identifier: issue.identifier, state: issue.state });
    }
    return out;
  }

  // ---- BoardReader ----
  async fetchAllIssues(): Promise<NormalizedIssue[]> {
    return (await this.store.listIssues()).map((i) => FileTracker.toNormalized(i));
  }

  async listWorkflowStates(): Promise<WorkflowStateInfo[]> {
    return this.store.readStates();
  }

  async listLabels(): Promise<LabelInfo[]> {
    const names = new Set<string>();
    for (const l of await this.store.readLabels()) names.add(l.name);
    for (const i of await this.store.listIssues()) for (const l of i.labels) names.add(l);
    return [...names].map((name) => ({ id: name, name }));
  }

  // ---- IssueWriter ----
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    let prev = '';
    await this.store.mutateIssue(issueId, (issue) => {
      prev = issue.state;
      return { ...issue, state: stateId, updatedAt: now() };
    });
    await this.store.appendActivity(issueId, {
      at: now(),
      field: 'state',
      verb: 'updated',
      oldValue: prev,
      newValue: stateId,
    });
  }

  async updateIssue(issueId: string, patch: IssuePatch): Promise<void> {
    const changes: IssueActivity[] = [];
    await this.store.mutateIssue(issueId, (issue) => {
      const next = { ...issue, updatedAt: now() };
      if (patch.title !== undefined && patch.title !== issue.title) {
        changes.push(activity('title', issue.title, patch.title));
        next.title = patch.title;
      }
      if (patch.description !== undefined && patch.description !== issue.description) {
        changes.push(activity('description', issue.description, patch.description));
        next.description = patch.description;
      }
      if (patch.priority !== undefined && patch.priority !== issue.priority) {
        changes.push(activity('priority', str(issue.priority), str(patch.priority)));
        next.priority = patch.priority;
      }
      if (patch.labelIds !== undefined) {
        changes.push(activity('labels', issue.labels.join(','), patch.labelIds.join(',')));
        next.labels = patch.labelIds;
      }
      if (patch.model !== undefined) {
        const nextModel = patch.model ?? undefined;
        if (nextModel !== issue.model) {
          changes.push(activity('model', issue.model ?? null, nextModel ?? null));
          if (nextModel === undefined) delete next.model;
          else next.model = nextModel;
        }
      }
      if (patch.effort !== undefined) {
        const nextEffort = patch.effort ?? undefined;
        if (nextEffort !== issue.effort) {
          changes.push(activity('effort', issue.effort ?? null, nextEffort ?? null));
          if (nextEffort === undefined) delete next.effort;
          else next.effort = nextEffort;
        }
      }
      // Usage is an orchestrator-written metadata field, not an operator edit — persist it
      // silently (no activity entry) to avoid flooding the history on every worker exit.
      if (patch.usage !== undefined) next.usage = patch.usage;
      return next;
    });
    for (const c of changes) await this.store.appendActivity(issueId, c);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.store.appendComment(issueId, { at: now(), body });
  }

  async uploadFile(input: UploadInput): Promise<{ assetUrl: string }> {
    return { assetUrl: await this.store.writeUpload(input.filename, input.data) };
  }

  async attachToIssue(issueId: string, url: string, title?: string): Promise<void> {
    await this.store.mutateIssue(issueId, (issue) => ({
      ...issue,
      attachments: [...(issue.attachments ?? []), { url, title: title ?? url }],
      updatedAt: now(),
    }));
    await this.store.appendActivity(issueId, {
      at: now(),
      field: 'attachment',
      verb: 'created',
      oldValue: null,
      newValue: url,
    });
  }

  // ---- IssueRemover ----
  async detachFromIssue(issueId: string, url: string): Promise<void> {
    await this.store.mutateIssue(issueId, (issue) => ({
      ...issue,
      attachments: (issue.attachments ?? []).filter((a) => a.url !== url),
      updatedAt: now(),
    }));
    await this.store.appendActivity(issueId, {
      at: now(),
      field: 'attachment',
      verb: 'deleted',
      oldValue: url,
      newValue: null,
    });
  }

  async deleteIssue(issueId: string): Promise<void> {
    await this.store.deleteIssue(issueId);
  }

  // ---- IssueCreator ----
  async createIssue(input: CreateIssueInput): Promise<NormalizedIssue> {
    const { identifier, seq } = await this.store.reserveId();
    const id = `${identifier}-${seq}`;
    let description = input.description ?? null;
    if (input.attachments?.length) {
      const md = input.attachments.map((a) => `![${a.title}](${a.url})`).join('\n');
      description = description ? `${description}\n\n${md}` : md;
    }
    const ts = now();
    const issue: StoredIssue = {
      id,
      identifier: id,
      title: input.title,
      description,
      priority: input.priority ?? null,
      state: input.stateName ?? input.stateId ?? 'Todo',
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: ts,
      updatedAt: ts,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    };
    await this.store.putNewIssue(issue);
    await this.store.appendActivity(id, {
      at: ts,
      field: null,
      verb: 'created',
      oldValue: null,
      newValue: null,
    });
    return FileTracker.toNormalized(issue);
  }

  /** Read one issue as a NormalizedIssue (used by the semantic tracker tools). */
  async getIssue(id: string): Promise<NormalizedIssue | null> {
    const s = await this.store.readIssue(id);
    return s ? FileTracker.toNormalized(s) : null;
  }

  // ---- PlanStore ----
  async updatePlan(
    issueId: string,
    fn: (prev: IssuePlan | undefined) => IssuePlan,
  ): Promise<IssuePlan> {
    let result: IssuePlan | undefined;
    await this.store.mutateIssue(issueId, (issue) => {
      const next = fn(issue.plan as IssuePlan | undefined);
      result = next;
      return { ...issue, plan: next, updatedAt: now() };
    });
    // mutateIssue always invokes fn, so result is set (it throws if the issue is missing).
    return result as IssuePlan;
  }

  async getPlan(issueId: string): Promise<IssuePlan | null> {
    const s = await this.store.readIssue(issueId);
    return s?.plan !== undefined ? (s.plan as IssuePlan) : null;
  }

  // ---- ActivityReader ----
  async fetchActivity(issueId: string): Promise<IssueActivity[]> {
    return this.store.readActivity(issueId);
  }

  async fetchComments(issueId: string): Promise<IssueComment[]> {
    return this.store.readComments(issueId);
  }
}

function activity(field: string, oldValue: string | null, newValue: string | null): IssueActivity {
  return { at: now(), field, verb: 'updated', oldValue, newValue };
}

function str(v: number | null): string | null {
  return v === null ? null : String(v);
}
