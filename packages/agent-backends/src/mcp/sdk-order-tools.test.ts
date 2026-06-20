import { describe, expect, it } from 'vitest';
import { validateOrderSubmission, type OrderSubmission } from './sdk-order-tools.js';

const selected = new Set(['a', 'b', 'c']);
const ticket = (id: string, blockedBy: string[] = []) => ({ id, blockedBy, rationale: 'because' });

describe('validateOrderSubmission', () => {
  it('accepts a complete, in-subset, dag-shaped submission', () => {
    const sub: OrderSubmission = {
      order: ['a', 'b', 'c'],
      tickets: [ticket('a'), ticket('b', ['a']), ticket('c', ['a', 'b'])],
      summary: 's',
    };
    expect(validateOrderSubmission(sub, selected)).toBeNull();
  });

  it('rejects an order id outside the selected set', () => {
    const sub: OrderSubmission = {
      order: ['a', 'b', 'z'],
      tickets: [ticket('a'), ticket('b'), ticket('c')],
      summary: 's',
    };
    expect(validateOrderSubmission(sub, selected)).toMatch(/z.*not in the selected set/);
  });

  it('rejects an incomplete order (missing a selected ticket)', () => {
    const sub: OrderSubmission = {
      order: ['a', 'b'],
      tickets: [ticket('a'), ticket('b')],
      summary: 's',
    };
    expect(validateOrderSubmission(sub, selected)).toMatch(/every selected ticket.*missing: c/);
  });

  it('rejects a duplicate id in the order', () => {
    const sub: OrderSubmission = {
      order: ['a', 'a', 'b'],
      tickets: [ticket('a'), ticket('b'), ticket('c')],
      summary: 's',
    };
    expect(validateOrderSubmission(sub, selected)).toMatch(/duplicate/);
  });

  it('rejects a self-edge', () => {
    const sub: OrderSubmission = {
      order: ['a', 'b', 'c'],
      tickets: [ticket('a', ['a']), ticket('b'), ticket('c')],
      summary: 's',
    };
    expect(validateOrderSubmission(sub, selected)).toMatch(/cannot block itself/);
  });

  it('rejects a blockedBy id outside the subset', () => {
    const sub: OrderSubmission = {
      order: ['a', 'b', 'c'],
      tickets: [ticket('a'), ticket('b', ['z']), ticket('c')],
      summary: 's',
    };
    expect(validateOrderSubmission(sub, selected)).toMatch(
      /blocked by "z".*not in the selected set/,
    );
  });

  it('rejects a missing per-ticket entry', () => {
    const sub: OrderSubmission = {
      order: ['a', 'b', 'c'],
      tickets: [ticket('a'), ticket('b')],
      summary: 's',
    };
    expect(validateOrderSubmission(sub, selected)).toMatch(
      /missing an entry for selected ticket c/,
    );
  });
});
