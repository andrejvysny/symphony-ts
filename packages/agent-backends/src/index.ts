export type {
  AgentRunStatus,
  PermissionMode,
  SettingSource,
  McpConfig,
  RunOptions,
  RunResult,
  AgentEvent,
  CodingAgentBackend,
} from './backend.js';
export { nowIso } from './backend.js';
export { ClaudeCodeSdkBackend } from './claude-sdk/claude-sdk-backend.js';
export {
  getClaudeUsageLimits,
  fetchClaudeUsageLimits,
  readClaudeOAuthToken,
  type ClaudeUsageLimits,
  type UsageWindow,
  type CredentialReader,
  type UsageFetchOptions,
} from './claude-sdk/usage-limits.js';
export { createBackend, type BackendKind, type BackendFactoryOptions } from './registry.js';
export {
  classify,
  isPermanentCategory,
  type ClassifyInput,
  type Classification,
} from './failure-classification.js';

// CLI stream-json backends
export { CliStreamJsonBackend, cliBackendFor } from './cli-stream-json/cli-backend.js';
export { runAgentDef } from './cli-stream-json/engine.js';
export {
  detectAgent,
  detectedCapabilities,
  clearDetectionCache,
  type DetectionResult,
  type DetectOptions,
  type AgentCapabilities,
} from './cli-stream-json/detect.js';
export {
  defaultTmuxController,
  tmuxAvailable,
  type TmuxController,
} from './cli-stream-json/tmux.js';
export {
  AGENT_DEFS,
  claudeCliDef,
  codexCliDef,
  opencodeCliDef,
  type AgentDef,
} from './cli-stream-json/agent-defs.js';
export { parseClaudeStreamJson } from './cli-stream-json/parsers/claude-stream-json.js';
export { parseCodexJsonl } from './cli-stream-json/parsers/codex-jsonl.js';
export { parseOpencodeJsonl } from './cli-stream-json/parsers/opencode-jsonl.js';
export { resultFromEvents, type ParseCtx } from './cli-stream-json/parsers/common.js';

// MCP tool wiring
export {
  buildTrackerSdkMcpServer,
  type TrackerSdkToolDeps,
  type TrackerApiExecutor,
  type TrackerToolResult,
} from './mcp/sdk-tracker-tool.js';
export {
  buildMemorySdkMcpServer,
  type MemoryToolExecutor,
  type MemoryToolResult,
} from './mcp/sdk-memory-tool.js';
export {
  buildPlanSdkMcpServer,
  askTool,
  ASK_DESCRIPTION,
  type PlanToolDeps,
  type AskQuestionInput,
} from './mcp/sdk-plan-tools.js';
export {
  buildOrderSdkMcpServer,
  validateOrderSubmission,
  type OrderToolDeps,
  type OrderSubmission,
  type OrderSubmissionTicket,
} from './mcp/sdk-order-tools.js';
