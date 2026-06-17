import type { AgentEvent, CodingAgentBackend, RunOptions, RunResult } from '../backend.js';
import { AGENT_DEFS, type AgentDef } from './agent-defs.js';
import { runAgentDef } from './engine.js';

/** A coding-agent backend driven by a declarative AgentDef + the central engine. */
export class CliStreamJsonBackend implements CodingAgentBackend {
  readonly kind: string;
  constructor(private readonly def: AgentDef) {
    this.kind = def.kind;
  }

  run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    return runAgentDef(this.def, opts);
  }
}

/**
 * Build a CLI backend for `kind`. An optional `command` overrides the def's default
 * `binary` (config `agent.command`) — e.g. a wrapper script or a non-PATH `claude`.
 * The def is shallow-cloned so the shared registry entry stays unmutated.
 */
export function cliBackendFor(kind: string, command?: string): CliStreamJsonBackend {
  const def = AGENT_DEFS[kind];
  if (!def) throw new Error(`no CLI agent def for kind "${kind}"`);
  const resolved = command ? { ...def, binary: command } : def;
  return new CliStreamJsonBackend(resolved);
}
