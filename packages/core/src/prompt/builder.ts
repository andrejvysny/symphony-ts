import { Liquid } from 'liquidjs';
import type { NormalizedIssue } from '@symphony/shared';
import { ConfigError } from '@symphony/shared';

const DEFAULT_PROMPT = `You are working on an issue from the tracker.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}`;

/** Liquid template input (SPEC §5.4): issue fields + attempt (null on first try). */
export interface PromptContext {
  issue: NormalizedIssue;
  attempt: number | null;
}

export class PromptBuilder {
  private readonly engine: Liquid;
  private readonly template: string;

  constructor(promptBody: string) {
    // Strict: unknown variables and filters MUST fail rendering (SPEC §5.4).
    this.engine = new Liquid({ strictVariables: true, strictFilters: true });
    this.template = promptBody.trim().length > 0 ? promptBody : DEFAULT_PROMPT;
  }

  build(issue: NormalizedIssue, attempt: number | null): string {
    try {
      return this.engine.parseAndRenderSync(this.template, { issue, attempt });
    } catch (e) {
      throw new ConfigError(`prompt render failed: ${(e as Error).message}`);
    }
  }

  /**
   * Finish-up nudge for the rare case where a delegation ends with the issue still active — the agent
   * stopped before parking it for review. Optionally enriched with the branch + a
   * `git status --porcelain` summary so the agent re-orients without re-deriving its cwd/state.
   * Deliberately carries NO turn-budget framing: the agent should finish or declare a blocker, not
   * pace itself across turns.
   */
  continuation(issue: NormalizedIssue, ctx: { branch?: string; gitStatus?: string } = {}): string {
    const lines = [
      `You stopped before parking ${issue.identifier}: "${issue.title}" for review — pick up where you left off and finish it now.`,
    ];
    if (ctx.branch) lines.push(`Branch: ${ctx.branch}.`);
    if (ctx.gitStatus !== undefined) {
      const status = ctx.gitStatus.trim();
      lines.push(
        status
          ? `Uncommitted changes so far:\n${status}`
          : 'Working tree is clean (no uncommitted changes yet).',
      );
    }
    lines.push(
      'Resume from your last commit — do not redo work you have already done. If the change is ' +
        'complete, verify it, commit, then post a summary comment with the verification output and ' +
        'commit SHA and move the issue to "Human Review". If you are genuinely blocked, state the ' +
        'specific blocker in plain text and leave the issue in "In Progress".',
    );
    return lines.join('\n');
  }
}
