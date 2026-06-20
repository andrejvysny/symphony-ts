import type { IssuePlan } from '@symphony/shared';
import { describe, expect, it } from 'vitest';
import { makeIssue } from '../test-support.js';
import { PromptBuilder } from './builder.js';

describe('PromptBuilder', () => {
  const issue = makeIssue({
    id: '1',
    identifier: 'MT-1',
    title: 'Add login',
    description: 'do it',
  });

  it('renders issue fields', () => {
    const b = new PromptBuilder('Work on {{ issue.identifier }}: {{ issue.title }}');
    expect(b.build(issue, null)).toBe('Work on MT-1: Add login');
  });

  it('falls back to the default template when body is empty', () => {
    const b = new PromptBuilder('');
    const out = b.build(issue, null);
    expect(out).toContain('MT-1');
    expect(out).toContain('Add login');
  });

  it('fails on unknown variables (strict)', () => {
    const b = new PromptBuilder('{{ issue.nope.deep }}');
    expect(() => b.build(issue, null)).toThrow();
  });

  it('appends an approved plan to the rendered body, and only when approved', () => {
    const b = new PromptBuilder('Work on {{ issue.identifier }}');
    const mkPlan = (status: IssuePlan['status']): IssuePlan => ({
      status,
      qa: [],
      comments: [],
      revision: 1,
      createdAt: '0',
      updatedAt: '0',
      markdown: '# Plan\n\nstep 1',
    });
    // Not appended while the plan is only ready (not yet approved).
    expect(b.build({ ...issue, plan: mkPlan('ready') }, null)).toBe('Work on MT-1');
    // Appended once approved.
    const out = b.build({ ...issue, plan: mkPlan('approved') }, null);
    expect(out).toContain('Work on MT-1');
    expect(out).toContain('operator-approved implementation plan');
    expect(out).toContain('# Plan\n\nstep 1');
  });

  it('produces a finish-up nudge with no turn-budget framing', () => {
    const b = new PromptBuilder('x');
    const out = b.continuation(issue);
    expect(out).toContain('MT-1');
    expect(out).toContain('Human Review');
    // The nudge must NOT pace the agent across turns.
    expect(out).not.toMatch(/turn \d+ of \d+/i);
  });

  it('enriches continuation with worktree branch + git status (O3)', () => {
    const b = new PromptBuilder('x');
    const out = b.continuation(issue, { branch: 'symphony/MT-1', gitStatus: ' M src/a.ts' });
    expect(out).toContain('symphony/MT-1');
    expect(out).toContain('src/a.ts');
    // An empty git status renders the clean-tree note.
    expect(b.continuation(issue, { branch: 'symphony/MT-1', gitStatus: '' })).toContain('clean');
  });
});
