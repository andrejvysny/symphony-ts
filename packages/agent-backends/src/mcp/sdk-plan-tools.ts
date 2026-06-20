import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * The shape of one question the planning agent asks via `symphony_ask` (no id — the orchestrator
 * assigns it). Mirrors the Claude AskUserQuestion schema so the dashboard can render it natively.
 */
export interface AskQuestionInput {
  header: string;
  question: string;
  options?: { label: string; description?: string; recommended?: boolean }[];
  multiSelect?: boolean;
}

/**
 * Executors backing the plan-mode SDK MCP tools. Built per plan run in the orchestrator (`startPlan`),
 * with closures bound to that run, and passed in here so this module stays orchestrator-agnostic.
 * `ask` blocks (live mode) or records-and-parks (pause mode) until the operator answers; `submitPlan`
 * captures the finished plan markdown.
 */
export interface PlanToolDeps {
  /** Ask the operator one or more questions at once; resolves to the answer text for the agent. */
  ask: (questions: AskQuestionInput[]) => Promise<string>;
  /** Record the finished plan markdown for operator review; resolves to an ack the agent reads. */
  submitPlan: (markdown: string, summary?: string) => Promise<string>;
}

const ASK_DESCRIPTION =
  'Ask the operator one or more clarifying questions and WAIT for their answer before continuing. ' +
  'Use this — never AskUserQuestion — whenever a decision genuinely needs the human (ambiguous scope, ' +
  'a trade-off only they can pick, missing context you cannot infer from the repo). Batch related ' +
  'questions into one call. For each question give a short header, the question text, and optionally ' +
  '2–4 labelled options (omit options for a free-text answer). If one option is the clear default, ' +
  'set recommended: true on it (at most one per question). Do not ask about things you can ' +
  'reasonably determine yourself by reading the code.';

const SUBMIT_PLAN_DESCRIPTION =
  'Submit the FINAL implementation plan for operator review, as GitHub-flavored markdown. Call this ' +
  'exactly once when the plan is complete: a clear, ordered, file-aware plan the operator (and a later ' +
  'implementation agent) can follow. Do not write or edit any files — planning is read-only; this tool ' +
  'is how you deliver the plan. After submitting, stop.';

/**
 * Build an in-process SDK MCP server exposing the plan-mode tools (`symphony_ask`,
 * `symphony_submit_plan`). Returns a fresh `mcpServers` map; call it once PER RUN (via the
 * `McpConfig.sdkServers` factory) so concurrent runs never share one server instance.
 */
export function buildPlanSdkMcpServer(deps: PlanToolDeps): Record<string, unknown> {
  const server = createSdkMcpServer({
    name: 'symphony-plan',
    version: '0.1.0',
    tools: [
      tool(
        'symphony_ask',
        ASK_DESCRIPTION,
        {
          questions: z
            .array(
              z.object({
                header: z.string().describe('Short chip label for the question (≤ ~12 chars).'),
                question: z.string().describe('The question to ask the operator.'),
                options: z
                  .array(
                    z.object({
                      label: z.string().describe('A selectable choice.'),
                      description: z
                        .string()
                        .optional()
                        .describe('What this choice means / its trade-off.'),
                      recommended: z
                        .boolean()
                        .optional()
                        .describe(
                          'Mark this as the recommended choice (at most one per question).',
                        ),
                    }),
                  )
                  .optional()
                  .describe('2–4 choices; omit entirely for a free-text answer.'),
                multiSelect: z
                  .boolean()
                  .optional()
                  .describe('Allow the operator to select more than one option.'),
              }),
            )
            .describe('One or more questions to ask the operator at once.'),
        },
        async (args) => {
          const text = await deps.ask(args.questions as AskQuestionInput[]);
          return { content: [{ type: 'text', text }], isError: false };
        },
      ),
      tool(
        'symphony_submit_plan',
        SUBMIT_PLAN_DESCRIPTION,
        {
          markdown: z
            .string()
            .describe('The full implementation plan as GitHub-flavored markdown.'),
          summary: z.string().optional().describe('Optional one-line summary of the plan.'),
        },
        async (args) => {
          const text = await deps.submitPlan(args.markdown, args.summary);
          return { content: [{ type: 'text', text }], isError: false };
        },
      ),
    ],
  });
  return { 'symphony-plan': server };
}
