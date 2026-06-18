import { describe, expect, it } from 'vitest';
import { configSchema } from './schema.js';

describe('config schema — agent/tracker prompt knobs', () => {
  it('defaults tracker.kind to file, review_state to "Human Review", backlog_state to "Backlog"', () => {
    const c = configSchema.parse({});
    expect(c.tracker.kind).toBe('file');
    expect(c.tracker.review_state).toBe('Human Review');
    expect(c.tracker.backlog_state).toBe('Backlog');
    expect(c.tracker.in_progress_state).toBe('In Progress');
    // Backlog stays out of the active set so the orchestrator never dispatches it; the in-progress
    // pickup target is an active state.
    expect(c.tracker.active_states).not.toContain('Backlog');
    expect(c.tracker.active_states).toContain('In Progress');
    // The prompt knobs are optional and unset by default.
    expect(c.agent.system_prompt).toBeUndefined();
    expect(c.agent.effort).toBeUndefined();
    expect(c.agent.thinking).toBeUndefined();
  });

  it('parses agent.system_prompt/effort/thinking and a custom review_state', () => {
    const c = configSchema.parse({
      tracker: { kind: 'file', review_state: 'In Review' },
      agent: { system_prompt: 'CONTRACT', effort: 'xhigh', thinking: 'adaptive' },
    });
    expect(c.tracker.review_state).toBe('In Review');
    expect(c.agent.system_prompt).toBe('CONTRACT');
    expect(c.agent.effort).toBe('xhigh');
    expect(c.agent.thinking).toBe('adaptive');
  });

  it('rejects an invalid effort level', () => {
    expect(() => configSchema.parse({ agent: { effort: 'ultra' } })).toThrow();
  });
});
