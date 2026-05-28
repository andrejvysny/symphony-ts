import { describe, expect, it } from 'vitest';
import { normalizeIssue } from './normalize.js';

describe('normalizeIssue', () => {
  it('lowercases labels, extracts blockers, and coerces priority', () => {
    const issue = normalizeIssue({
      id: 'i1',
      identifier: 'MT-1',
      title: 'Title',
      description: null,
      priority: 2,
      branchName: 'feat/x',
      url: 'https://linear.app/x',
      state: { name: 'In Progress' },
      labels: { nodes: [{ name: 'Bug' }, { name: 'P1' }] },
      inverseRelations: {
        nodes: [
          { type: 'blocks', issue: { id: 'b1', identifier: 'MT-9', state: { name: 'Todo' } } },
          { type: 'related', issue: { id: 'r1', identifier: 'MT-8', state: { name: 'Done' } } },
        ],
      },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    });

    expect(issue.labels).toEqual(['bug', 'p1']);
    expect(issue.state).toBe('In Progress');
    expect(issue.priority).toBe(2);
    expect(issue.blockedBy).toEqual([{ id: 'b1', identifier: 'MT-9', state: 'Todo' }]);
  });

  it('nulls non-integer priority and missing fields', () => {
    const issue = normalizeIssue({
      id: 'i2',
      identifier: 'MT-2',
      title: 'T',
      priority: 1.5 as unknown as number,
    });
    expect(issue.priority).toBeNull();
    expect(issue.description).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(issue.blockedBy).toEqual([]);
    expect(issue.state).toBe('');
  });
});
