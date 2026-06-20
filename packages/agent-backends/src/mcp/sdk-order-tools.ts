import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { askTool, type AskQuestionInput } from './sdk-plan-tools.js';

/** One ticket's place in the agent-proposed sequence (mirrors @symphony/shared OrderProposalTicket). */
export interface OrderSubmissionTicket {
  id: string;
  blockedBy: string[];
  rationale: string;
}

/** The structured payload the sequencing agent submits via `symphony_submit_order`. */
export interface OrderSubmission {
  order: string[];
  tickets: OrderSubmissionTicket[];
  summary: string;
}

/**
 * Executors backing the sequence-mode SDK MCP tools, built per ordering run in the orchestrator
 * (`startOrder`) with closures bound to that run. `ask` reuses the plan-mode Q&A machinery;
 * `submitOrder` validates + records the proposed order, returning `{ ok, text }` so a STRUCTURAL
 * failure surfaces as an `isError` tool result the agent can self-correct from in-session.
 */
export interface OrderToolDeps {
  ask: (questions: AskQuestionInput[]) => Promise<string>;
  submitOrder: (submission: OrderSubmission) => Promise<{ ok: boolean; text: string }>;
}

const SUBMIT_ORDER_DESCRIPTION =
  'Submit the FINAL recommended implementation order for the given set of backlog tickets. Call this ' +
  'exactly once when your analysis is complete. Provide: `order` — every given ticket id exactly once, ' +
  'earliest-to-implement first; `tickets` — one entry per ticket with `blockedBy` (ids of OTHER given ' +
  'tickets that must ship before it; omit/empty when independent) and a one–two sentence `rationale` ' +
  'grounded in the repo; and a short overall `summary`. Reference tickets ONLY by the ids you were ' +
  'given. Do not write or edit files — this is read-only analysis; this tool is how you deliver the ' +
  'order. After submitting, stop.';

/**
 * Build an in-process SDK MCP server exposing the sequence-mode tools (`symphony_ask`,
 * `symphony_submit_order`). Returns a fresh `mcpServers` map; call it once PER RUN (via the
 * `McpConfig.sdkServers` factory) so concurrent runs never share one server instance.
 */
export function buildOrderSdkMcpServer(deps: OrderToolDeps): Record<string, unknown> {
  const server = createSdkMcpServer({
    name: 'symphony-order',
    version: '0.1.0',
    tools: [
      askTool(deps.ask),
      tool(
        'symphony_submit_order',
        SUBMIT_ORDER_DESCRIPTION,
        {
          order: z
            .array(z.string())
            .min(1)
            .describe(
              'Every given ticket id exactly once, in recommended implementation order (earliest first).',
            ),
          tickets: z
            .array(
              z.object({
                id: z.string().describe('A given ticket id.'),
                blockedBy: z
                  .array(z.string())
                  .default([])
                  .describe('Ids of OTHER given tickets that must be implemented before this one.'),
                rationale: z
                  .string()
                  .describe('One–two sentences: why this position / what it depends on.'),
              }),
            )
            .min(1)
            .describe('One entry per given ticket: its dependencies + a short rationale.'),
          summary: z
            .string()
            .describe('Short overall summary of the sequence and the main dependency drivers.'),
        },
        async (args) => {
          const r = await deps.submitOrder(args as OrderSubmission);
          return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
        },
      ),
    ],
  });
  return { 'symphony-order': server };
}

/**
 * Pure STRUCTURAL validation of a submitted order against the selected subset (no repo / semantic
 * checks; cycle-safety is enforced at the orchestrator's commit step by filtering edges to the final
 * linear order). Returns an operator/agent-facing error string, or null when the submission is valid.
 */
export function validateOrderSubmission(
  sub: OrderSubmission,
  selectedIds: Set<string>,
): string | null {
  const orderSet = new Set(sub.order);
  if (orderSet.size !== sub.order.length) return 'order contains duplicate ids.';
  for (const id of sub.order)
    if (!selectedIds.has(id)) return `order contains id "${id}" which is not in the selected set.`;
  if (sub.order.length !== selectedIds.size) {
    const missing = [...selectedIds].filter((id) => !orderSet.has(id));
    return `order must list every selected ticket exactly once; missing: ${missing.join(', ') || '(none)'}.`;
  }
  const ticketIds = new Set(sub.tickets.map((t) => t.id));
  if (ticketIds.size !== sub.tickets.length) return 'tickets contains duplicate entries.';
  for (const t of sub.tickets) {
    if (!selectedIds.has(t.id))
      return `tickets references id "${t.id}" which is not in the selected set.`;
    for (const b of t.blockedBy) {
      if (b === t.id) return `ticket ${t.id} cannot block itself.`;
      if (!selectedIds.has(b))
        return `ticket ${t.id} is blocked by "${b}" which is not in the selected set.`;
    }
  }
  for (const id of selectedIds)
    if (!ticketIds.has(id)) return `tickets is missing an entry for selected ticket ${id}.`;
  return null;
}
