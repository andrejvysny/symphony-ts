import { describe, expect, it } from 'vitest';
import { PromptBuilder } from '../prompt/builder.js';
import { makeIssue } from '../test-support.js';
import { parseWorkflowFile } from '../workflow/loader.js';
import { parseConfig, resolveConfig } from './resolve.js';
import { WORKFLOW_TEMPLATE } from './workflow-template.js';

// The starter `symphony init` writes must always parse + render — it's a user's first contact.
describe('WORKFLOW_TEMPLATE', () => {
  it('parses into a valid config (single_dir + claude-sdk, dashboard on)', () => {
    const { frontMatter, promptBody } = parseWorkflowFile(WORKFLOW_TEMPLATE);
    const config = resolveConfig(parseConfig(frontMatter), '/tmp');
    expect(config.tracker.kind).toBe('file');
    expect(config.workspace.mode).toBe('single_dir');
    expect(config.agent.backend).toBe('claude-sdk');
    expect(config.server?.port).toBe(4500);
    expect(config.tracker.project_id).toBeUndefined(); // no active project by default
    expect(promptBody.length).toBeGreaterThan(0);
  });

  it('renders its prompt body for an issue (strict Liquid vars)', () => {
    const { promptBody } = parseWorkflowFile(WORKFLOW_TEMPLATE);
    const out = new PromptBuilder(promptBody).build(
      makeIssue({ id: 'SYM-1', identifier: 'SYM-1', title: 'Add dark mode' }),
      null,
    );
    expect(out).toContain('SYM-1');
    expect(out).toContain('Add dark mode');
  });
});
