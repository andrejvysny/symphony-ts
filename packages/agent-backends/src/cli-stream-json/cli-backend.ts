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

export function cliBackendFor(kind: string): CliStreamJsonBackend {
  const def = AGENT_DEFS[kind];
  if (!def) throw new Error(`no CLI agent def for kind "${kind}"`);
  return new CliStreamJsonBackend(def);
}
