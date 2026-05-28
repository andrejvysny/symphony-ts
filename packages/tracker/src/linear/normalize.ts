import type { Blocker, NormalizedIssue } from '@symphony/shared';

interface RawRelationNode {
  type?: string;
  issue?: { id?: string; identifier?: string; state?: { name?: string } };
}

export interface RawLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  branchName?: string | null;
  url?: string | null;
  state?: { name?: string };
  labels?: { nodes?: Array<{ name?: string }> };
  inverseRelations?: { nodes?: RawRelationNode[] };
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** Map a Linear issue node into the tracker-neutral model (SPEC §3, §11.1). */
export function normalizeIssue(raw: RawLinearIssue): NormalizedIssue {
  const labels = (raw.labels?.nodes ?? [])
    .map((l) => (l.name ?? '').toLowerCase())
    .filter((n) => n.length > 0);

  const blockedBy: Blocker[] = (raw.inverseRelations?.nodes ?? [])
    .filter((n) => n.type === 'blocks' && n.issue?.id && n.issue.identifier)
    .map((n) => ({
      id: n.issue!.id!,
      identifier: n.issue!.identifier!,
      state: n.issue!.state?.name ?? '',
    }));

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? null,
    priority: Number.isInteger(raw.priority) ? (raw.priority as number) : null,
    state: raw.state?.name ?? '',
    branchName: raw.branchName ?? null,
    url: raw.url ?? null,
    labels,
    blockedBy,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}
