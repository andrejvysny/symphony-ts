import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  nowIso,
  type AgentEvent,
  type AgentRunStatus,
  type CodingAgentBackend,
  type RunOptions,
  type RunResult,
} from '../backend.js';

/** Tools that mean "the agent needs a human decision" → surface as blocked. */
const NEEDS_INPUT_TOOLS = new Set(['AskUserQuestion']);

function baseToolName(name: string): string {
  // mcp tools look like mcp__server__tool; take the trailing segment.
  const parts = name.split('__');
  return parts[parts.length - 1] ?? name;
}

function mapSubtype(subtype: string): AgentRunStatus {
  switch (subtype) {
    case 'success':
      return 'success';
    case 'error_max_turns':
      return 'error_max_turns';
    case 'error_max_budget_usd':
      return 'error_budget';
    default:
      return 'error_execution';
  }
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blocksOf(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown })?.content;
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

/**
 * Drives local Claude Code via the Agent SDK `query()`. Normalizes SDK messages
 * into the shared AgentEvent vocabulary. One `run()` call = one turn.
 */
export class ClaudeCodeSdkBackend implements CodingAgentBackend {
  readonly kind = 'claude-sdk';

  async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const ac = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    let blockedReason: string | undefined;
    const canUseTool: CanUseTool = async (toolName, input) => {
      if (NEEDS_INPUT_TOOLS.has(baseToolName(toolName))) {
        blockedReason = `agent requested operator input via ${toolName}`;
        return {
          behavior: 'deny',
          message: 'This is a non-interactive session. Operator input is unavailable.',
          interrupt: true,
        };
      }
      return { behavior: 'allow', updatedInput: input };
    };

    const options: Options = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? 'bypassPermissions',
      canUseTool,
      abortController: ac,
      includePartialMessages: false,
      // Inherit host login + project settings/skills.
      settingSources: ['user', 'project', 'local'],
      stderr: () => {},
    };
    if (opts.model !== undefined) options.model = opts.model;
    if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;
    if (opts.maxBudgetUsd !== undefined) options.maxBudgetUsd = opts.maxBudgetUsd;
    if (opts.allowedTools !== undefined) options.allowedTools = opts.allowedTools;
    if (opts.disallowedTools !== undefined) options.disallowedTools = opts.disallowedTools;
    if (opts.resumeSessionId !== undefined) options.resume = opts.resumeSessionId;
    if (opts.mcpConfig?.sdkServers !== undefined) {
      options.mcpServers = opts.mcpConfig.sdkServers as Record<string, McpServerConfig>;
    }

    let sessionId: string | undefined;
    let result: RunResult | undefined;

    try {
      for await (const msg of query({
        prompt: opts.prompt,
        options,
      }) as AsyncGenerator<SDKMessage>) {
        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init') {
              sessionId = msg.session_id;
              yield { type: 'session_started', sessionId: msg.session_id, at: nowIso() };
            }
            break;
          }
          case 'assistant': {
            for (const block of blocksOf(msg.message)) {
              if (block.type === 'text' && block.text) {
                yield { type: 'text_delta', text: block.text, at: nowIso() };
              } else if (block.type === 'tool_use') {
                yield {
                  type: 'tool_use',
                  toolName: block.name ?? 'unknown',
                  toolUseId: block.id ?? '',
                  input: block.input,
                  at: nowIso(),
                };
              }
            }
            break;
          }
          case 'user': {
            for (const block of blocksOf(msg.message)) {
              if (block.type === 'tool_result') {
                yield {
                  type: 'tool_result',
                  toolUseId: block.tool_use_id ?? '',
                  isError: block.is_error === true,
                  content: block.content,
                  at: nowIso(),
                };
              }
            }
            break;
          }
          case 'result': {
            const usage = msg.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            const inputTokens = usage?.input_tokens ?? 0;
            const outputTokens = usage?.output_tokens ?? 0;
            yield {
              type: 'usage',
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              costUsd: msg.total_cost_usd,
              absolute: true,
              at: nowIso(),
            };
            const status: AgentRunStatus = blockedReason ? 'blocked' : mapSubtype(msg.subtype);
            result = {
              status,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              costUsd: msg.total_cost_usd,
              numTurns: msg.num_turns,
              ...(sessionId !== undefined ? { sessionId } : {}),
            };
            if (status === 'blocked') {
              yield {
                type: 'input_required',
                reason: blockedReason ?? 'operator input required',
                at: nowIso(),
              };
            } else if (msg.subtype === 'success') {
              yield { type: 'turn_completed', at: nowIso() };
            } else {
              const error = msg.errors?.join('; ') || msg.subtype;
              result.error = error;
              yield { type: 'turn_failed', error, at: nowIso() };
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      result = {
        status: 'error_execution',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        error,
        errorCategory: 'response_error',
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
      yield { type: 'turn_failed', error, at: nowIso() };
    }

    const final: RunResult = result ?? {
      status: 'error_execution',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: 'agent produced no result message',
      errorCategory: 'process_exit',
    };
    yield { type: 'result', result: final, at: nowIso() };
    return final;
  }
}
