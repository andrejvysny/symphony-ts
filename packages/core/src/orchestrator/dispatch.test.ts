import { describe, expect, it } from 'vitest';
import { makeIssue } from '../test-support.js';
import { blockedByNonTerminal, retryDelay, sortForDispatch } from './dispatch.js';

describe('sortForDispatch', () => {
  it('orders by priority asc, then createdAt, then identifier', () => {
    const a = makeIssue({ id: 'a', identifier: 'A-1', priority: 2, createdAt: '2024-01-01' });
    const b = makeIssue({ id: 'b', identifier: 'B-1', priority: 1, createdAt: '2024-02-01' });
    const c = makeIssue({ id: 'c', identifier: 'C-1', priority: 1, createdAt: '2024-01-01' });
    const d = makeIssue({ id: 'd', identifier: 'D-1', priority: null, createdAt: '2020-01-01' });
    const sorted = sortForDispatch([a, b, c, d]).map((i) => i.id);
    expect(sorted).toEqual(['c', 'b', 'a', 'd']); // null priority sorts last; no ranks → legacy order
  });

  it('rank is the primary key (lower first), ignoring priority among ranked tickets', () => {
    // r2 outranks r1 by priority but has a higher rank → dispatches later.
    const r1 = makeIssue({ id: 'r1', identifier: 'A-1', rank: 1, priority: 4 });
    const r2 = makeIssue({ id: 'r2', identifier: 'B-1', rank: 2, priority: 1 });
    expect(sortForDispatch([r2, r1]).map((i) => i.id)).toEqual(['r1', 'r2']);
  });

  it('ranked tickets sort before unranked, which keep the legacy order', () => {
    const u1 = makeIssue({ id: 'u1', identifier: 'A-1', priority: 1, createdAt: '2024-01-01' });
    const u2 = makeIssue({ id: 'u2', identifier: 'B-1', priority: null, createdAt: '2024-01-01' });
    const r = makeIssue({ id: 'r', identifier: 'C-1', rank: 5, priority: null });
    expect(sortForDispatch([u2, u1, r]).map((i) => i.id)).toEqual(['r', 'u1', 'u2']);
  });

  it('breaks a rank tie by priority then createdAt then identifier', () => {
    const a = makeIssue({ id: 'a', identifier: 'A-1', rank: 1, priority: 2 });
    const b = makeIssue({ id: 'b', identifier: 'B-1', rank: 1, priority: 1 });
    expect(sortForDispatch([a, b]).map((i) => i.id)).toEqual(['b', 'a']);
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

describe('blockedByNonTerminal', () => {
  const terminal = new Set(['Done', 'Canceled', 'Cancelled', 'Duplicate']);
  it('is blocked when a blocker is non-terminal', () => {
    const issue = makeIssue({
      id: 'x',
      blockedBy: [{ id: 'y', identifier: 'Y-1', state: 'In Progress' }],
    });
    expect(blockedByNonTerminal(issue, terminal)).toBe(true);
  });
  it('is not blocked when all blockers are terminal', () => {
    const issue = makeIssue({
      id: 'x',
      blockedBy: [{ id: 'y', identifier: 'Y-1', state: 'Done' }],
    });
    expect(blockedByNonTerminal(issue, terminal)).toBe(false);
  });
  it('treats a Cancelled/Duplicate blocker as satisfied (terminal of any kind)', () => {
    const issue = makeIssue({
      id: 'x',
      blockedBy: [
        { id: 'y', identifier: 'Y-1', state: 'Cancelled' },
        { id: 'z', identifier: 'Z-1', state: 'Duplicate' },
      ],
    });
    expect(blockedByNonTerminal(issue, terminal)).toBe(false);
  });
  it('an empty blocker set is never blocked', () => {
    expect(blockedByNonTerminal(makeIssue({ id: 'x' }), terminal)).toBe(false);
  });
});
