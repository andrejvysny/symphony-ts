import { describe, expect, it } from 'vitest';
import { emptyTokenState, integrateUsage } from './token-accounting.js';

const at = new Date(0).toISOString();

describe('integrateUsage', () => {
  it('accumulates absolute totals as deltas vs last-reported', () => {
    const s = emptyTokenState();
    const d1 = integrateUsage(s, {
      type: 'usage',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      absolute: true,
      at,
    });
    expect(d1.totalTokens).toBe(150);
    expect(s.totalTokens).toBe(150);
    const d2 = integrateUsage(s, {
      type: 'usage',
      inputTokens: 120,
      outputTokens: 70,
      totalTokens: 190,
      absolute: true,
      at,
    });
    expect(d2.totalTokens).toBe(40);
    expect(s.totalTokens).toBe(190);
    expect(s.inputTokens).toBe(120);
  });

  it('never goes negative when totals regress', () => {
    const s = emptyTokenState();
    integrateUsage(s, {
      type: 'usage',
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      absolute: true,
      at,
    });
    const d = integrateUsage(s, {
      type: 'usage',
      inputTokens: 50,
      outputTokens: 50,
      totalTokens: 100,
      absolute: true,
      at,
    });
    expect(d.totalTokens).toBe(0);
    expect(s.totalTokens).toBe(200); // unchanged
  });

  it('ignores delta-style (non-absolute) payloads', () => {
    const s = emptyTokenState();
    const d = integrateUsage(s, {
      type: 'usage',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      absolute: false,
      at,
    });
    expect(d.totalTokens).toBe(0);
    expect(s.totalTokens).toBe(0);
  });

  it('accumulates costUsd as an absolute delta, never negative', () => {
    const s = emptyTokenState();
    const d1 = integrateUsage(s, { type: 'usage', costUsd: 0.05, absolute: true, at });
    expect(d1.costUsd).toBeCloseTo(0.05);
    expect(s.costUsd).toBeCloseTo(0.05);
    const d2 = integrateUsage(s, { type: 'usage', costUsd: 0.12, absolute: true, at });
    expect(d2.costUsd).toBeCloseTo(0.07);
    expect(s.costUsd).toBeCloseTo(0.12);
    // Regression keeps the prior total.
    const d3 = integrateUsage(s, { type: 'usage', costUsd: 0.03, absolute: true, at });
    expect(d3.costUsd).toBe(0);
    expect(s.costUsd).toBeCloseTo(0.12);
  });
});
