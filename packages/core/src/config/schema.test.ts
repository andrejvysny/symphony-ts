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

  it('defaults to one-delegation re-prompt budget (max_turns 2, max_continuations 1)', () => {
    const c = configSchema.parse({});
    // One full delegation + at most one finish-up nudge, then block — not a deep re-prompt loop.
    expect(c.agent.max_turns).toBe(2);
    expect(c.agent.max_continuations).toBe(1);
    // The agent's OWN internal step budget is uncapped by default (one delegation runs to completion).
    expect(c.agent.max_agent_steps).toBeUndefined();
  });

  it('defaults agent.usage_limits on (opt-out; gated to Claude backends at the source)', () => {
    const c = configSchema.parse({});
    expect(c.agent.usage_limits).toBe(true);
    expect(configSchema.parse({ agent: { usage_limits: false } }).agent.usage_limits).toBe(false);
  });

  it('parses an explicit max_agent_steps cap', () => {
    const c = configSchema.parse({ agent: { max_agent_steps: 200 } });
    expect(c.agent.max_agent_steps).toBe(200);
    expect(() => configSchema.parse({ agent: { max_agent_steps: 0 } })).toThrow();
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
