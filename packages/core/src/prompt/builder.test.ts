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

  it('produces continuation guidance referencing the turn', () => {
    const b = new PromptBuilder('x');
    expect(b.continuation(issue, 3, 20)).toContain('MT-1');
    expect(b.continuation(issue, 3, 20)).toContain('turn 3 of 20');
  });

  it('enriches continuation with worktree branch + git status (O3)', () => {
    const b = new PromptBuilder('x');
    const out = b.continuation(issue, 2, 5, { branch: 'symphony/MT-1', gitStatus: ' M src/a.ts' });
    expect(out).toContain('symphony/MT-1');
    expect(out).toContain('src/a.ts');
    // An empty git status renders the clean-tree note.
    expect(b.continuation(issue, 2, 5, { branch: 'symphony/MT-1', gitStatus: '' })).toContain(
      'clean',
    );
  });
});
