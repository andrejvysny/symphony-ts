import type { Blocker, NormalizedIssue } from '@symphony/shared';

/** Raw Plane work-item shape (only the fields we read; everything optional/defensive). */
export interface RawPlaneIssue {
  id: string;
  sequence_id?: number;
  name?: string;
  description?: string | null;
  description_stripped?: string | null;
  description_html?: string | null;
  /** 'urgent' | 'high' | 'medium' | 'low' | 'none' */
  priority?: string | null;
  /** state UUID (default), or an object when `?expand=state` is used */
  state?: string | null;
  /** label UUIDs (default), or objects when expanded */
  labels?: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

/** Lookup tables + project coordinates needed to normalize a Plane issue. */
export interface NormalizeContext {
  /** state UUID → state name */
  stateNameById: Map<string, string>;
  /** label UUID → lowercased label name */
  labelNameById: Map<string, string>;
  /** project identifier prefix, e.g. `SYM` */
  projectIdentifier: string;
  /** base instance URL (no trailing slash), for building the web URL */
  endpoint: string;
  workspaceSlug: string;
  projectId: string;
}

/**
 * Plane priority is a string enum; the orchestrator treats priority as an int it only
 * sorts ascending (nulls last). Map to match Linear semantics: urgent→1 … low→4, none→null.
 */
export function planePriorityToInt(p: string | null | undefined): number | null {
  switch (p) {
    case 'urgent':
      return 1;
    case 'high':
      return 2;
    case 'medium':
      return 3;
    case 'low':
      return 4;
    default:
      return null; // 'none' | undefined | unknown
  }
}

/** Inverse of {@link planePriorityToInt} for writes (createIssue). */
export function intToPlanePriority(n: number | undefined): string | undefined {
  switch (n) {
    case 1:
      return 'urgent';
    case 2:
      return 'high';
    case 3:
      return 'medium';
    case 4:
      return 'low';
    default:
      return undefined;
  }
}

/** Prefer plaintext; never feed HTML into the agent's Liquid prompt. Empty → null. */
function plaintextDescription(raw: RawPlaneIssue): string | null {
  const t = raw.description_stripped ?? raw.description;
  if (typeof t === 'string' && t.trim().length > 0) return t;
  return null;
}

/** Map a Plane work item into the tracker-neutral model (joins UUIDs → names via ctx). */
export function normalizeIssue(raw: RawPlaneIssue, ctx: NormalizeContext): NormalizedIssue {
  const identifier =
    raw.sequence_id !== undefined
      ? `${ctx.projectIdentifier}-${raw.sequence_id}`
      : ctx.projectIdentifier;

  const labels = (raw.labels ?? [])
    .map((id) => ctx.labelNameById.get(id) ?? '')
    .filter((n) => n.length > 0);

  // LIMITATION: Plane's public /api/v1/ does not expose issue relations, so the orchestrator's
  // blocked-by auto-skip is disabled. Manage blocking by keeping blocked issues out of active_states.
  const blockedBy: Blocker[] = [];

  return {
    id: raw.id,
    identifier,
    title: raw.name ?? '',
    description: plaintextDescription(raw),
    priority: planePriorityToInt(raw.priority),
    state: raw.state ? (ctx.stateNameById.get(raw.state) ?? '') : '',
    // LIMITATION: Plane has no branchName; the worker derives branches from `identifier`.
    branchName: null,
    url: `${ctx.endpoint}/${ctx.workspaceSlug}/projects/${ctx.projectId}/issues/${raw.id}`,
    labels,
    blockedBy,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}
