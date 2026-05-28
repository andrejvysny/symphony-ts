import type { AgentEvent } from '../../backend.js';
import { at, contentBlocks, type ParseCtx } from './common.js';

/** Parse one `claude -p --output-format stream-json` JSONL object. */
export function parseClaudeStreamJson(json: unknown, ctx: ParseCtx): AgentEvent[] {
  const msg = json as Record<string, unknown>;
  const out: AgentEvent[] = [];

  switch (msg['type']) {
    case 'system': {
      if (msg['subtype'] === 'init' && typeof msg['session_id'] === 'string') {
        ctx.sessionId = msg['session_id'];
        out.push({ type: 'session_started', sessionId: msg['session_id'], at: at() });
      }
      break;
    }
    case 'assistant': {
      for (const b of contentBlocks(msg['message'])) {
        if (b.type === 'text' && b.text) out.push({ type: 'text_delta', text: b.text, at: at() });
        else if (b.type === 'tool_use')
          out.push({
            type: 'tool_use',
            toolName: b.name ?? 'unknown',
            toolUseId: b.id ?? '',
            input: b.input,
            at: at(),
          });
      }
      break;
    }
    case 'user': {
      for (const b of contentBlocks(msg['message'])) {
        if (b.type === 'tool_result')
          out.push({
            type: 'tool_result',
            toolUseId: b.tool_use_id ?? '',
            isError: b.is_error === true,
            content: b.content,
            at: at(),
          });
      }
      break;
    }
    case 'result': {
      const usage = msg['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
      const input = usage?.input_tokens ?? 0;
      const output = usage?.output_tokens ?? 0;
      out.push({
        type: 'usage',
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        ...(typeof msg['total_cost_usd'] === 'number' ? { costUsd: msg['total_cost_usd'] } : {}),
        absolute: true,
        at: at(),
      });
      if (msg['subtype'] === 'success') out.push({ type: 'turn_completed', at: at() });
      else {
        const errs = msg['errors'];
        const error = Array.isArray(errs) ? errs.join('; ') : String(msg['subtype'] ?? 'error');
        out.push({ type: 'turn_failed', error, at: at() });
      }
      break;
    }
    default:
      break;
  }
  return out;
}
