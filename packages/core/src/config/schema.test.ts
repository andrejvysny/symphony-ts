import { describe, expect, it } from 'vitest';
import { configSchema } from './schema.js';

describe('config schema — agent/tracker prompt knobs', () => {
  it('defaults review_state to "Human Review" and allow_raw_tracker_api to false', () => {
    const c = configSchema.parse({ tracker: { kind: 'plane' } });
    expect(c.tracker.review_state).toBe('Human Review');
    expect(c.agent.allow_raw_tracker_api).toBe(false);
    // The new prompt knobs are optional and unset by default.
    expect(c.agent.system_prompt).toBeUndefined();
    expect(c.agent.effort).toBeUndefined();
    expect(c.agent.thinking).toBeUndefined();
  });

  it('parses agent.system_prompt/effort/thinking and a custom review_state', () => {
    const c = configSchema.parse({
      tracker: { kind: 'plane', review_state: 'In Review' },
      agent: { system_prompt: 'CONTRACT', effort: 'xhigh', thinking: 'adaptive' },
    });
    expect(c.tracker.review_state).toBe('In Review');
    expect(c.agent.system_prompt).toBe('CONTRACT');
    expect(c.agent.effort).toBe('xhigh');
    expect(c.agent.thinking).toBe('adaptive');
  });

  it('rejects an invalid effort level', () => {
    expect(() =>
      configSchema.parse({ tracker: { kind: 'plane' }, agent: { effort: 'ultra' } }),
    ).toThrow();
  });
});
