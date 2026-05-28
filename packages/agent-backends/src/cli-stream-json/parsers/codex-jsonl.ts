import type { AgentEvent } from '../../backend.js';
import { at, type ParseCtx } from './common.js';

const ELICITATION_RE = /elicit|input.?required|needs.?input|approval/i;

/** Parse one `codex exec --json` JSONL event (ThreadEvent). */
export function parseCodexJsonl(json: unknown, ctx: ParseCtx): AgentEvent[] {
  const ev = json as Record<string, unknown>;
  const out: AgentEvent[] = [];
  const type = String(ev['type'] ?? '');

  switch (type) {
    case 'thread.started': {
      const id = (ev['thread_id'] ?? ev['threadId']) as string | undefined;
      if (id) {
        ctx.sessionId = id;
        out.push({ type: 'session_started', sessionId: id, at: at() });
      }
      break;
    }
    case 'item.completed':
    case 'item.started': {
      const item = ev['item'] as Record<string, unknown> | undefined;
      const itemType = String(item?.['type'] ?? item?.['item_type'] ?? '');
      if (itemType === 'agent_message' || itemType === 'assistant_message') {
        const text = (item?.['text'] ?? item?.['message']) as string | undefined;
        if (text) out.push({ type: 'text_delta', text, at: at() });
      } else if (
        itemType.includes('command') ||
        itemType.includes('tool') ||
        itemType.includes('file_change')
      ) {
        if (type === 'item.started')
          out.push({
            type: 'tool_use',
            toolName: itemType,
            toolUseId: String(item?.['id'] ?? ''),
            input: item,
            at: at(),
          });
        else
          out.push({
            type: 'tool_result',
            toolUseId: String(item?.['id'] ?? ''),
            isError: false,
            content: item,
            at: at(),
          });
      }
      break;
    }
    case 'turn.completed': {
      const usage = ev['usage'] as Record<string, number> | undefined;
      const input = Number(usage?.['input_tokens'] ?? usage?.['prompt_tokens'] ?? 0);
      const output = Number(usage?.['output_tokens'] ?? usage?.['completion_tokens'] ?? 0);
      out.push({
        type: 'usage',
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        absolute: true,
        at: at(),
      });
      out.push({ type: 'turn_completed', at: at() });
      break;
    }
    case 'turn.failed':
    case 'error': {
      const errObj = (ev['error'] ?? ev['message']) as { message?: string } | string | undefined;
      const error = typeof errObj === 'string' ? errObj : (errObj?.message ?? type);
      if (ELICITATION_RE.test(error)) out.push({ type: 'input_required', reason: error, at: at() });
      else out.push({ type: 'turn_failed', error, at: at() });
      break;
    }
    default:
      break;
  }
  return out;
}
