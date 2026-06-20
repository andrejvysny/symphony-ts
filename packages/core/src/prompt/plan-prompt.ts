import type { NormalizedIssue, PlanComment, PlanQuestion } from '@symphony/shared';

/**
 * Default system-prompt APPEND text for a PLAN-MODE run, layered on the Claude `claude_code` preset.
 * Plan runs are read-only (`permissionMode:'plan'`): the agent investigates the repo and produces a
 * reviewable implementation plan — it does NOT write code, move the ticket, or use the tracker tools.
 * It asks the operator via `symphony_ask` and delivers the plan via `symphony_submit_plan`.
 * Override wholesale via `plan.system_prompt`.
 */
export const DEFAULT_PLAN_SYSTEM_PROMPT = `<role>
You are Symphony's planning agent. You investigate ONE backlog ticket read-only and produce a concrete, reviewable implementation plan for it. You do not implement anything — a separate agent will execute the approved plan later.
</role>

<read_only>
This is a read-only planning session. Do not create, edit, move, or delete files; do not run mutating commands or commit. Use your read and search tools (Read, Grep, Glob, and read-only shell) to ground the plan in the real code. If you find yourself wanting to change a file, that belongs in the plan, not in this session.
</read_only>

<approach>
Investigate before planning: read the relevant code, trace the data flow, and find the existing patterns, functions, and utilities the change should reuse. Then write a plan that is specific to THIS codebase — name the exact files to change, the functions/types involved, and the order of work — not a generic checklist. Prefer reusing what exists over inventing new abstractions. Call out risks, edge cases, and how the change should be verified.
</approach>

<questions>
When a decision genuinely needs the human — ambiguous or contradictory requirements, a trade-off only they can choose, or missing context you cannot infer from the repo — ask via the symphony_ask tool and wait for the answer. Batch related questions into one call, give each a short header and 2–4 labelled options where it helps, and leave options off for a free-text answer. Do not ask about things you can determine yourself by reading the code, and do not use AskUserQuestion — symphony_ask is the only way to reach the operator here.
</questions>

<deliverable>
When the plan is complete, deliver it by calling symphony_submit_plan exactly once with the full plan as GitHub-flavored markdown, then stop. Structure it for a reader: a short summary, then ordered steps with the files involved, then verification. The operator will review, comment on, and edit the plan before approving it for implementation.
</deliverable>`;

function issueHeader(issue: NormalizedIssue): string {
  return `Ticket: ${issue.identifier} — ${issue.title}\n\n${
    issue.description && issue.description.trim().length > 0
      ? issue.description
      : 'No description provided.'
  }`;
}

/**
 * First-turn prompt for a plan run: investigate read-only and produce a plan.
 * `customInstructions` is the operator's optional free-text steer from the dashboard's plan-start
 * panel; when present it is surfaced as a high-priority directive the agent should honour.
 */
export function planInitialPrompt(issue: NormalizedIssue, customInstructions?: string): string {
  const extra = customInstructions?.trim();
  return [
    'Produce an implementation plan for the following backlog ticket.',
    '',
    issueHeader(issue),
    ...(extra
      ? [
          '',
          'Operator instructions for this plan (prioritize these over your own assumptions):',
          extra,
        ]
      : []),
    '',
    'Investigate the repository read-only, ask the operator via the symphony_ask tool if you genuinely need a decision, and when the plan is ready submit it via symphony_submit_plan as GitHub-flavored markdown.',
  ].join('\n');
}

/** Render answered questions as a readable block (used in the tool result + pause-resume prompt). */
export function formatPlanAnswers(
  questions: PlanQuestion[],
  answers: Record<string, string | string[]>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    const text = Array.isArray(a) ? a.join(', ') : (a ?? '(no answer)');
    lines.push(`- ${q.question}\n  → ${text}`);
  }
  return lines.join('\n');
}

/** Resume prompt after the operator answers a pause-mode question batch. */
export function planAnswersPrompt(
  issue: NormalizedIssue,
  questions: PlanQuestion[],
  answers: Record<string, string | string[]>,
): string {
  return [
    `The operator answered your questions about ${issue.identifier}:`,
    '',
    formatPlanAnswers(questions, answers),
    '',
    'Continue planning. Ask further questions via symphony_ask only if still necessary, otherwise submit the plan via symphony_submit_plan.',
  ].join('\n');
}

/** Resume prompt asking the agent to revise the plan to address the operator's open comments. */
export function planRevisionPrompt(issue: NormalizedIssue, comments: PlanComment[]): string {
  const blocks = comments.map((c) => `- On "${c.anchor.exact}":\n  ${c.body}`).join('\n');
  return [
    `The operator reviewed your plan for ${issue.identifier} and left comments to address. Produce a revised plan that resolves each one:`,
    '',
    blocks.length > 0 ? blocks : '(no specific comments — refine and tighten the plan)',
    '',
    'When the revised plan is ready, submit it via symphony_submit_plan.',
  ].join('\n');
}
