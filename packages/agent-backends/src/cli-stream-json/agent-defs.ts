import type { AgentEvent, RunOptions } from '../backend.js';
import type { ParseCtx } from './parsers/common.js';
import { parseClaudeStreamJson } from './parsers/claude-stream-json.js';
import { parseCodexJsonl } from './parsers/codex-jsonl.js';
import { parseOpencodeJsonl } from './parsers/opencode-jsonl.js';

/**
 * Declarative adapter (nexu-io/open-design pattern): each agent is a config object
 * describing how to build argv, deliver the prompt, and parse its stream. One engine
 * (engine.ts) spawns + streams, branching only on these fields.
 */
export interface AgentDef {
  kind: string;
  binary: string;
  promptViaStdin: boolean;
  buildArgs: (opts: RunOptions, promptOmitted: boolean) => string[];
  parser: (line: unknown, ctx: ParseCtx) => AgentEvent[];
  env?: (opts: RunOptions) => Record<string, string>;
}

function mcpConfigArg(opts: RunOptions): string[] {
  const stdio = opts.mcpConfig?.stdioServers;
  if (!stdio || Object.keys(stdio).length === 0) return [];
  return ['--mcp-config', JSON.stringify({ mcpServers: stdio })];
}

export const claudeCliDef: AgentDef = {
  kind: 'claude-cli',
  binary: 'claude',
  promptViaStdin: true,
  buildArgs: (o) => [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.maxTurns ? ['--max-turns', String(o.maxTurns)] : []),
    '--permission-mode',
    o.permissionMode ?? 'bypassPermissions',
    ...(o.allowedTools?.length ? ['--allowedTools', o.allowedTools.join(',')] : []),
    ...(o.disallowedTools?.length ? ['--disallowedTools', o.disallowedTools.join(',')] : []),
    ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []),
    ...mcpConfigArg(o),
  ],
  parser: parseClaudeStreamJson,
};

export const codexCliDef: AgentDef = {
  kind: 'codex-cli',
  binary: 'codex',
  promptViaStdin: false,
  buildArgs: (o) => [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    o.cwd,
    ...(o.model ? ['--model', o.model] : []),
    '--dangerously-bypass-approvals-and-sandbox',
    o.prompt,
  ],
  parser: parseCodexJsonl,
};

export const opencodeCliDef: AgentDef = {
  kind: 'opencode-cli',
  binary: 'opencode',
  promptViaStdin: false,
  buildArgs: (o) => [
    'run',
    '--format',
    'json',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.resumeSessionId ? ['--session', o.resumeSessionId] : []),
    o.prompt,
  ],
  parser: parseOpencodeJsonl,
};

export const AGENT_DEFS: Record<string, AgentDef> = {
  'claude-cli': claudeCliDef,
  'codex-cli': codexCliDef,
  'opencode-cli': opencodeCliDef,
};
