import { describe, expect, it } from 'vitest';
import {
  intToPlanePriority,
  normalizeIssue,
  planePriorityToInt,
  type NormalizeContext,
  type RawPlaneIssue,
} from './normalize.js';

function makeCtx(overrides?: Partial<NormalizeContext>): NormalizeContext {
  return {
    stateNameById: new Map([['state-uuid', 'In Progress']]),
    labelNameById: new Map([
      ['label-uuid-1', 'bug'],
      ['label-uuid-2', 'feature'],
    ]),
    projectIdentifier: 'SYM',
    endpoint: 'http://plane.example',
    workspaceSlug: 'my-ws',
    projectId: 'proj-123',
    ...overrides,
  };
}

function makeRaw(overrides?: Partial<RawPlaneIssue>): RawPlaneIssue {
  return {
    id: 'issue-abc',
    sequence_id: 12,
    name: 'Test Issue',
    state: 'state-uuid',
    labels: [],
    ...overrides,
  };
}

describe('normalizeIssue: identifier', () => {
  it('builds identifier as projectIdentifier-sequence_id', () => {
    const issue = normalizeIssue(makeRaw({ sequence_id: 12 }), makeCtx());
    expect(issue.identifier).toBe('SYM-12');
  });

  it('falls back to just projectIdentifier when sequence_id is absent', () => {
    const raw = makeRaw();
    delete raw.sequence_id;
    const issue = normalizeIssue(raw, makeCtx());
    expect(issue.identifier).toBe('SYM');
  });
});

describe('normalizeIssue: labels', () => {
  it('resolves label UUIDs to lowercased names', () => {
    const issue = normalizeIssue(makeRaw({ labels: ['label-uuid-1', 'label-uuid-2'] }), makeCtx());
    expect(issue.labels).toEqual(['bug', 'feature']);
  });

  it('filters out unknown label UUIDs', () => {
    const issue = normalizeIssue(makeRaw({ labels: ['label-uuid-1', 'unknown-uuid'] }), makeCtx());
    expect(issue.labels).toEqual(['bug']);
  });

  it('returns empty labels for empty labels array', () => {
    const issue = normalizeIssue(makeRaw({ labels: [] }), makeCtx());
    expect(issue.labels).toEqual([]);
  });
});

describe('planePriorityToInt', () => {
  it.each([
    ['urgent', 1],
    ['high', 2],
    ['medium', 3],
    ['low', 4],
    ['none', null],
    [undefined, null],
    ['unknown', null],
    [null, null],
  ] as const)('maps %s → %s', (input, expected) => {
    expect(planePriorityToInt(input)).toBe(expected);
  });
});

describe('intToPlanePriority', () => {
  it.each([
    [1, 'urgent'],
    [2, 'high'],
    [3, 'medium'],
    [4, 'low'],
    [0, undefined],
    [5, undefined],
    [undefined, undefined],
  ] as const)('maps %s → %s', (input, expected) => {
    expect(intToPlanePriority(input)).toBe(expected);
  });
});

describe('normalizeIssue: state', () => {
  it('resolves state UUID to name', () => {
    const issue = normalizeIssue(makeRaw({ state: 'state-uuid' }), makeCtx());
    expect(issue.state).toBe('In Progress');
  });

  it('returns empty string for unknown state UUID', () => {
    const issue = normalizeIssue(makeRaw({ state: 'unknown-state' }), makeCtx());
    expect(issue.state).toBe('');
  });

  it('returns empty string when state is null', () => {
    const issue = normalizeIssue(makeRaw({ state: null }), makeCtx());
    expect(issue.state).toBe('');
  });

  it('returns empty string when state is absent', () => {
    const raw = makeRaw();
    delete raw.state;
    const issue = normalizeIssue(raw, makeCtx());
    expect(issue.state).toBe('');
  });
});

describe('normalizeIssue: description', () => {
  it('prefers description_stripped over description', () => {
    const issue = normalizeIssue(
      makeRaw({ description_stripped: 'clean text', description: 'raw text' }),
      makeCtx(),
    );
    expect(issue.description).toBe('clean text');
  });

  it('falls back to description when description_stripped is absent', () => {
    const issue = normalizeIssue(makeRaw({ description: 'raw text' }), makeCtx());
    expect(issue.description).toBe('raw text');
  });

  it('returns null for whitespace-only description_stripped', () => {
    const issue = normalizeIssue(makeRaw({ description_stripped: '   ' }), makeCtx());
    expect(issue.description).toBeNull();
  });

  it('returns null for whitespace-only description', () => {
    const issue = normalizeIssue(makeRaw({ description: '\t\n' }), makeCtx());
    expect(issue.description).toBeNull();
  });

  it('returns null when only description_html is present (HTML never leaks into prompt)', () => {
    const issue = normalizeIssue(makeRaw({ description_html: '<p>html content</p>' }), makeCtx());
    expect(issue.description).toBeNull();
  });

  it('returns null when all description fields are absent', () => {
    const issue = normalizeIssue(makeRaw(), makeCtx());
    expect(issue.description).toBeNull();
  });
});

describe('normalizeIssue: fixed fields', () => {
  it('blockedBy is always []', () => {
    const issue = normalizeIssue(makeRaw(), makeCtx());
    expect(issue.blockedBy).toEqual([]);
  });

  it('branchName is always null', () => {
    const issue = normalizeIssue(makeRaw(), makeCtx());
    expect(issue.branchName).toBeNull();
  });

  it('builds url from endpoint/workspaceSlug/projectId/id', () => {
    const issue = normalizeIssue(makeRaw({ id: 'issue-abc' }), makeCtx());
    expect(issue.url).toBe('http://plane.example/my-ws/projects/proj-123/issues/issue-abc');
  });

  it('passes through createdAt and updatedAt', () => {
    const issue = normalizeIssue(
      makeRaw({ created_at: '2024-01-01T00:00:00Z', updated_at: '2024-06-01T00:00:00Z' }),
      makeCtx(),
    );
    expect(issue.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(issue.updatedAt).toBe('2024-06-01T00:00:00Z');
  });

  it('returns null for absent createdAt/updatedAt', () => {
    const issue = normalizeIssue(makeRaw(), makeCtx());
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
  });
});
