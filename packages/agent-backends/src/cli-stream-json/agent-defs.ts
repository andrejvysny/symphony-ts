import type { AgentEvent, RunOptions } from '../backend.js';
import type { AgentCapabilities } from './detect.js';
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
  buildArgs: (opts: RunOptions, promptOmitted: boolean, caps?: AgentCapabilities) => string[];
  parser: (line: unknown, ctx: ParseCtx) => AgentEvent[];
  env?: (opts: RunOptions) => Record<string, string>;
  /** Args to read the version (detection, best-effort). */
  versionArgs?: string[];
  /** Args to print help (detection probes these for capability flags). */
  helpArgs?: string[];
  /** Help-substring → capability key (detection sets each capability true if its substring appears). */
  capabilityFlags?: Record<string, keyof AgentCapabilities>;
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
  versionArgs: ['--version'],
  // `--include-partial-messages`/`--add-dir` live under the `claude -p` subcommand, so probe its help.
  helpArgs: ['-p', '--help'],
  capabilityFlags: {
    '--include-partial-messages': 'partialMessages',
    '--add-dir': 'addDir',
  },
  buildArgs: (o, _promptOmitted, caps) => [
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
    // Hermetic by default: ignore the host's global/project MCP servers (which can stall a turn);
    // only Symphony's own `--mcp-config` servers load. Disabled with strictMcpConfig === false.
    ...(o.strictMcpConfig !== false ? ['--strict-mcp-config'] : []),
    // Live streaming deltas — opt-in and only when the installed build supports the flag.
    ...(o.streamPartialMessages && caps?.partialMessages ? ['--include-partial-messages'] : []),
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
