import { describe, expect, it } from 'vitest';
import { makeIssue } from '../test-support.js';
import { retryDelay, sortForDispatch, todoBlockedByNonTerminal } from './dispatch.js';

describe('sortForDispatch', () => {
  it('orders by priority asc, then createdAt, then identifier', () => {
    const a = makeIssue({ id: 'a', identifier: 'A-1', priority: 2, createdAt: '2024-01-01' });
    const b = makeIssue({ id: 'b', identifier: 'B-1', priority: 1, createdAt: '2024-02-01' });
    const c = makeIssue({ id: 'c', identifier: 'C-1', priority: 1, createdAt: '2024-01-01' });
    const d = makeIssue({ id: 'd', identifier: 'D-1', priority: null, createdAt: '2020-01-01' });
    const sorted = sortForDispatch([a, b, c, d]).map((i) => i.id);
    expect(sorted).toEqual(['c', 'b', 'a', 'd']); // null priority sorts last
  });
});

describe('retryDelay', () => {
  it('uses fixed 1s for continuation', () => {
    expect(retryDelay(1, 'continuation', 300_000)).toBe(1_000);
    expect(retryDelay(5, 'continuation', 300_000)).toBe(1_000);
  });
  it('uses capped exponential backoff for failures', () => {
    expect(retryDelay(1, 'failure', 300_000)).toBe(10_000);
    expect(retryDelay(2, 'failure', 300_000)).toBe(20_000);
    expect(retryDelay(3, 'failure', 300_000)).toBe(40_000);
    expect(retryDelay(99, 'failure', 300_000)).toBe(300_000); // capped
  });
});

describe('todoBlockedByNonTerminal', () => {
  const terminal = new Set(['Done', 'Canceled']);
  it('is blocked when a blocker is non-terminal', () => {
    const issue = makeIssue({
      id: 'x',
      blockedBy: [{ id: 'y', identifier: 'Y-1', state: 'In Progress' }],
    });
    expect(todoBlockedByNonTerminal(issue, terminal)).toBe(true);
  });
  it('is not blocked when all blockers are terminal', () => {
    const issue = makeIssue({
      id: 'x',
      blockedBy: [{ id: 'y', identifier: 'Y-1', state: 'Done' }],
    });
    expect(todoBlockedByNonTerminal(issue, terminal)).toBe(false);
  });
});
