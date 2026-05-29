export const CORE_VERSION = '0.1.0';

// config
export {
  configSchema,
  DEFAULT_ACTIVE_STATES,
  DEFAULT_TERMINAL_STATES,
  type ParsedConfig,
  type TrackerConfig,
  type AgentConfig,
  type WorkspaceConfig,
  type HooksConfig,
  type ServerConfig,
} from './config/schema.js';
export {
  parseConfig,
  resolveConfig,
  normalizeRawConfig,
  type SymphonyConfig,
} from './config/resolve.js';
export { dispatchPreflight, type PreflightResult } from './config/validate.js';
export { loadConfig, type LoadedConfig } from './config/load.js';

// workflow
export { loadWorkflowFile, parseWorkflowFile, type LoadedWorkflow } from './workflow/loader.js';
export { WorkflowStore, type WorkflowSnapshot } from './workflow/store.js';

// prompt
export { PromptBuilder, type PromptContext } from './prompt/builder.js';

// workspace
export { WorkspaceManager, type Workspace, type IWorkspaceManager } from './workspace/manager.js';
export {
  sanitizeIdentifier,
  canonicalize,
  assertUnderRoot,
  assertCwdIsWorkspace,
} from './workspace/path-safety.js';
export { runHook, type HookName, type HookOutcome } from './workspace/hooks.js';
export {
  ensureSharedClone,
  addWorktree,
  removeWorktree,
  type SharedRepo,
} from './workspace/git-worktree.js';

// orchestrator
export {
  Orchestrator,
  type OrchestratorDeps,
  type OrchestratorSnapshot,
  type SessionInfo,
} from './orchestrator/orchestrator.js';
export {
  runWorker,
  type WorkerOutcome,
  type WorkerDeps,
  type WorkerContext,
} from './orchestrator/worker.js';
export { sortForDispatch, retryDelay, todoBlockedByNonTerminal } from './orchestrator/dispatch.js';
export {
  integrateUsage,
  emptyTokenState,
  type TokenState,
  type TokenDelta,
} from './orchestrator/token-accounting.js';

// observability
export { type Logger, type LogFields, noopLogger } from './observability/logger.js';
export { createLogger } from './observability/pino-logger.js';

// runtime factories
export { buildTracker, buildBackend, buildWorkspaceManager, buildMcpConfig } from './runtime.js';

// dashboard source
export {
  buildDashboardSource,
  type DashboardSource,
  type BoardData,
  type BoardStateDTO,
  type BoardIssueDTO,
  type IssueStatus,
  type CreateTicketInput,
  type CreateTicketFile,
} from './dashboard-source.js';
