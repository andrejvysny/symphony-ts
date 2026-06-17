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
import type { ErrorCategory } from '@symphony/shared';
import { classify } from '../failure-classification.js';

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
      // Live deltas only when requested (default off → full-message granularity).
      includePartialMessages: opts.streamPartialMessages ?? false,
      // Settings layers to inherit. Default `['project','local']` (worktree's own .claude config),
      // dropping the host-global `user` layer for reproducibility; configurable via agent.setting_sources.
      settingSources: opts.settingSources ?? ['project', 'local'],
      stderr: () => {},
    };
    if (opts.model !== undefined) options.model = opts.model;
    if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;
    if (opts.maxBudgetUsd !== undefined) options.maxBudgetUsd = opts.maxBudgetUsd;
    if (opts.allowedTools !== undefined) options.allowedTools = opts.allowedTools;
    if (opts.disallowedTools !== undefined) options.disallowedTools = opts.disallowedTools;
    if (opts.resumeSessionId !== undefined) options.resume = opts.resumeSessionId;
    if (opts.mcpConfig?.sdkServers !== undefined) {
      // Build a FRESH server instance for this run: an SDK MCP server can only be
      // connected to one transport at a time, so concurrent runs must not share one.
      options.mcpServers = opts.mcpConfig.sdkServers() as Record<string, McpServerConfig>;
    }
    // System prompt: layer Symphony's operating contract on Claude Code's built-in preset
    // (its tool/coding/safety guidance) instead of the SDK's bare default (which omits them).
    options.systemPrompt =
      opts.systemPrompt !== undefined && opts.systemPrompt.length > 0
        ? { type: 'preset', preset: 'claude_code', append: opts.systemPrompt }
        : { type: 'preset', preset: 'claude_code' };
    if (opts.effort !== undefined) options.effort = opts.effort;
    if (opts.thinking !== undefined)
      options.thinking = opts.thinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' };

    let sessionId: string | undefined;
    let result: RunResult | undefined;

    // Enforce a per-run wall-clock timeout (the SDK does not honor one itself): abort and
    // report turn_timeout. External-signal aborts are handled by the worker, which
    // re-checks signal.aborted and returns `aborted` before inspecting this result.
    let timedOut = false;
    const timeoutMs = opts.timeoutMs;
    const timeoutTimer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, timeoutMs)
        : undefined;

    // Soft idle watchdog: abort if no SDK message arrives for `idleTimeoutMs`. Reset on every
    // message (incl. tool activity) so long-but-active runs survive. 0/undefined disables.
    let idledOut = false;
    const idleMs = opts.idleTimeoutMs ?? 0;
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        ac.abort();
      }, idleMs);
    };
    resetIdle();

    try {
      for await (const msg of query({
        prompt: opts.prompt,
        options,
      }) as AsyncGenerator<SDKMessage>) {
        resetIdle();
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
            // `result.usage` is the absolute usage for THIS query() (one run = one turn here).
            // The orchestrator integrates it as an absolute total and adds the positive delta
            // (token-accounting.ts). Note: across resumed continuation turns the SDK does not
            // expose a thread-cumulative total, so multi-turn-within-one-worker token totals may
            // be approximate; `max_budget_usd` is the authoritative per-run spend bound.
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
              const c = classify({ text: error });
              // A budget stop is a hard cap (operator must raise max_budget_usd) → never retry.
              const retryable = status === 'error_budget' ? false : c.retryable;
              result.error = error;
              result.errorCategory = c.category;
              result.retryable = retryable;
              yield { type: 'turn_failed', error, category: c.category, at: nowIso() };
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (e) {
      const error = timedOut
        ? `claude-sdk turn exceeded timeout of ${timeoutMs}ms`
        : idledOut
          ? `no agent activity for ${idleMs}ms (idle watchdog)`
          : e instanceof Error
            ? e.message
            : String(e);
      const c = timedOut
        ? { category: 'turn_timeout' as ErrorCategory, retryable: true }
        : idledOut
          ? { category: 'idle_timeout' as ErrorCategory, retryable: true }
          : classify({ text: error });
      result = {
        status: 'error_execution',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        error,
        errorCategory: c.category,
        retryable: c.retryable,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
      yield { type: 'turn_failed', error, category: c.category, at: nowIso() };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }

    const final: RunResult = result ?? {
      status: 'error_execution',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: 'agent produced no result message',
      errorCategory: 'response_error',
      retryable: true,
    };
    yield { type: 'result', result: final, at: nowIso() };
    return final;
  }
}
