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
  it('uses capped exponential backoff for failures, equal-jittered into [base/2, base)', () => {
    // rng=0 → exactly base/2 (the floor); rng→1 → just under base.
    expect(retryDelay(1, 'failure', 300_000, () => 0)).toBe(5_000);
    expect(retryDelay(2, 'failure', 300_000, () => 0)).toBe(10_000);
    expect(retryDelay(3, 'failure', 300_000, () => 0)).toBe(20_000);
    expect(retryDelay(99, 'failure', 300_000, () => 0)).toBe(150_000); // capped base 300k → 150k
    // Upper end stays strictly below base for every attempt.
    expect(retryDelay(1, 'failure', 300_000, () => 0.999999)).toBeLessThan(10_000);
    expect(retryDelay(99, 'failure', 300_000, () => 0.999999)).toBeLessThan(300_000);
  });
  it('keeps the default (Math.random) failure delay within [base/2, base)', () => {
    for (let i = 0; i < 50; i++) {
      const d = retryDelay(1, 'failure', 300_000);
      expect(d).toBeGreaterThanOrEqual(5_000);
      expect(d).toBeLessThan(10_000);
    }
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
