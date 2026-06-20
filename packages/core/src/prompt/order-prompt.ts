import type { NormalizedIssue, PlanQuestion } from '@symphony/shared';
import { formatPlanAnswers } from './plan-prompt.js';

/**
 * Default system-prompt APPEND text for a SEQUENCE/ORDER run, layered on the Claude `claude_code`
 * preset. Like plan mode the run is read-only (`permissionMode:'plan'`), but it operates on a SET of
 * tickets: it investigates the repo and proposes the best implementation ORDER + the dependencies
 * between the given tickets — it does NOT plan how to implement any ticket or change their scope.
 * Override wholesale via `order.system_prompt`.
 */
export const DEFAULT_ORDER_SYSTEM_PROMPT = `<role>
You are Symphony's sequencing agent. You are given a fixed SET of backlog tickets. You investigate the repository read-only and propose the order in which they should be implemented, plus the dependencies between them. You do NOT plan how to implement any ticket, and you do NOT change ticket scope.
</role>

<read_only>
This is a read-only analysis session. Do not create, edit, move, or delete files; do not run mutating commands or commit. Use your read and search tools (Read, Grep, Glob, and read-only shell) to ground every dependency in the real code.
</read_only>

<scope>
Work ONLY with the tickets you are given. Do not invent new tickets, do not split or combine them, and do not propose changes to their titles or descriptions. Your job is purely: (1) the order, (2) which given ticket blocks which, and (3) a short rationale per ticket. Every dependency you state must reference a ticket in the given set.
</scope>

<approach>
Ground every dependency in the code: if ticket B touches a module, type, or interface that ticket A introduces or changes, then B depends on A. Prefer fewer, defensible edges over a fully-connected guess. If two tickets are independent, do NOT invent an edge to force a total order — list them both in the order, with no blockedBy between them.
</approach>

<questions>
When a decision genuinely needs the human — ambiguous scope, a trade-off only they can pick, or missing context you cannot infer from the repo — ask via the symphony_ask tool and wait for the answer. Batch related questions into one call. Do not ask about things you can determine yourself by reading the code, and do not use AskUserQuestion — symphony_ask is the only way to reach the operator here.
</questions>

<deliverable>
When ready, call symphony_submit_order exactly once with: order (every given ticket id, once, earliest first), tickets (per-ticket blockedBy ids + a one–two sentence rationale), and a short summary. Every id you reference must be one of the given tickets. Then stop.
</deliverable>`;

const DESCRIPTION_LIMIT = 600;

function serializeTicket(issue: NormalizedIssue): string {
  const priority = issue.priority === null ? '—' : `P${issue.priority}`;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  const desc = (issue.description ?? '').trim();
  const body =
    desc.length === 0
      ? 'No description.'
      : desc.length > DESCRIPTION_LIMIT
        ? `${desc.slice(0, DESCRIPTION_LIMIT)}…`
        : desc;
  return [
    `[${issue.identifier}] (id: ${issue.id})  ${priority}${labels}`,
    `  Title: ${issue.title}`,
    `  ${body.replace(/\n/g, '\n  ')}`,
  ].join('\n');
}

/**
 * First-turn prompt for an ordering run: serialize the N selected tickets (the agent has no tracker
 * tools in plan-permission mode, so this is its only context) and ask for the best order + deps.
 * Pass `issues` already in a stable order (the orchestrator sorts them) for a cache-friendly prompt.
 */
export function orderInitialPrompt(issues: NormalizedIssue[], customInstructions?: string): string {
  const extra = customInstructions?.trim();
  return [
    `Propose the best implementation order for the following ${issues.length} backlog tickets, and the dependencies between them.`,
    '',
    '=== TICKETS ===',
    issues.map(serializeTicket).join('\n\n'),
    '=== END TICKETS ===',
    '',
    'When you reference a ticket in symphony_submit_order, use its id (the value after "id:").',
    ...(extra
      ? [
          '',
          'Operator instructions for this ordering (prioritize these over your own assumptions):',
          extra,
        ]
      : []),
    '',
    'Investigate the repository read-only, ask the operator via symphony_ask only if you genuinely need a decision, then submit the order via symphony_submit_order.',
  ].join('\n');
}

/** Resume prompt after the operator answers a pause-mode question batch on an ordering run. */
export function orderAnswersPrompt(
  questions: PlanQuestion[],
  answers: Record<string, string | string[]>,
): string {
  return [
    'The operator answered your questions about the ticket set:',
    '',
    formatPlanAnswers(questions, answers),
    '',
    'Continue. Ask further questions via symphony_ask only if still necessary, otherwise submit the order via symphony_submit_order.',
  ].join('\n');
}
