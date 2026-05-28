import type { CodingAgentBackend } from './backend.js';
import { ClaudeCodeSdkBackend } from './claude-sdk/claude-sdk-backend.js';
import { cliBackendFor } from './cli-stream-json/cli-backend.js';

export type BackendKind = 'claude-sdk' | 'claude-cli' | 'codex-cli' | 'opencode-cli';

export interface BackendFactoryOptions {
  /** CLI backends only: override the base binary/command. */
  command?: string;
}

/** Construct a coding-agent backend by kind. */
export function createBackend(
  kind: BackendKind,
  _opts: BackendFactoryOptions = {},
): CodingAgentBackend {
  switch (kind) {
    case 'claude-sdk':
      return new ClaudeCodeSdkBackend();
    case 'claude-cli':
    case 'codex-cli':
    case 'opencode-cli':
      return cliBackendFor(kind);
    default:
      throw new Error(`unknown backend kind: ${String(kind)}`);
  }
}
