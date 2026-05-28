import type { AgentEvent } from '../../backend.js';
import { at, type ParseCtx } from './common.js';

/** Parse one `opencode run --format json` JSONL event. */
export function parseOpencodeJsonl(json: unknown, ctx: ParseCtx): AgentEvent[] {
  const ev = json as Record<string, unknown>;
  const out: AgentEvent[] = [];
  const type = String(ev['type'] ?? '');

  switch (type) {
    case 'step_start': {
      const id = (ev['sessionID'] ?? ev['session_id']) as string | undefined;
      if (id && !ctx.sessionId) {
        ctx.sessionId = id;
        out.push({ type: 'session_started', sessionId: id, at: at() });
      }
      break;
    }
    case 'text': {
      const text = (ev['text'] ?? ev['content']) as string | undefined;
      if (text) out.push({ type: 'text_delta', text, at: at() });
      break;
    }
    case 'tool_use':
    case 'tool': {
      const name = String(ev['tool'] ?? ev['name'] ?? 'tool');
      out.push({
        type: 'tool_use',
        toolName: name,
        toolUseId: String(ev['id'] ?? ''),
        input: ev['input'],
        at: at(),
      });
      if (ev['output'] !== undefined)
        out.push({
          type: 'tool_result',
          toolUseId: String(ev['id'] ?? ''),
          isError: ev['status'] === 'error',
          content: ev['output'],
          at: at(),
        });
      break;
    }
    case 'step_finish': {
      const part = (ev['part'] ?? ev) as Record<string, unknown>;
      const tokens = (part['tokens'] ?? ev['tokens']) as Record<string, number> | undefined;
      const input = Number(tokens?.['input'] ?? 0);
      const output = Number(tokens?.['output'] ?? 0);
      const cost = part['cost'] ?? ev['cost'];
      out.push({
        type: 'usage',
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        ...(typeof cost === 'number' ? { costUsd: cost } : {}),
        absolute: true,
        at: at(),
      });
      const reason = String(ev['reason'] ?? part['reason'] ?? 'stop');
      if (reason === 'stop') out.push({ type: 'turn_completed', at: at() });
      else if (reason === 'tool_denied' || reason === 'input_required')
        out.push({ type: 'input_required', reason, at: at() });
      else out.push({ type: 'turn_failed', error: `step finished: ${reason}`, at: at() });
      break;
    }
    case 'error': {
      const err = ev['error'] as { name?: string; data?: { message?: string } } | undefined;
      out.push({
        type: 'turn_failed',
        error: err?.data?.message ?? err?.name ?? 'error',
        at: at(),
      });
      break;
    }
    default:
      break;
  }
  return out;
}
