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

  /** Continuation guidance for in-worker turns after the first (SPEC §7.1). */
  continuation(issue: NormalizedIssue, turn: number, maxTurns: number): string {
    return [
      `Continue working on ${issue.identifier} (turn ${turn} of ${maxTurns}).`,
      'Resume from where you left off. When the work is complete, move the ticket to its next',
      'workflow state. If you are blocked and need operator input, say so explicitly.',
    ].join(' ');
  }
}
