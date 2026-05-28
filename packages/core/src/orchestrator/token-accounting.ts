import type { AgentEvent } from '@symphony/agent-backends';

export interface TokenState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastReportedInput: number;
  lastReportedOutput: number;
  lastReportedTotal: number;
}

export function emptyTokenState(): TokenState {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    lastReportedInput: 0,
    lastReportedOutput: 0,
    lastReportedTotal: 0,
  };
}

export interface TokenDelta {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Integrate a usage event into a per-session token state (SPEC §13.5).
 * Only ABSOLUTE thread totals feed cumulative accounting; delta-style payloads
 * are ignored. Deltas are computed vs the last-reported absolute totals to avoid
 * double counting. Returns the positive delta to add to global totals.
 */
export function integrateUsage(
  state: TokenState,
  ev: Extract<AgentEvent, { type: 'usage' }>,
): TokenDelta {
  if (!ev.absolute) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  const nextInput = ev.inputTokens ?? state.lastReportedInput;
  const nextOutput = ev.outputTokens ?? state.lastReportedOutput;
  const nextTotal = ev.totalTokens ?? nextInput + nextOutput;

  const dInput = Math.max(0, nextInput - state.lastReportedInput);
  const dOutput = Math.max(0, nextOutput - state.lastReportedOutput);
  const dTotal = Math.max(0, nextTotal - state.lastReportedTotal);

  state.inputTokens += dInput;
  state.outputTokens += dOutput;
  state.totalTokens += dTotal;
  state.lastReportedInput = Math.max(state.lastReportedInput, nextInput);
  state.lastReportedOutput = Math.max(state.lastReportedOutput, nextOutput);
  state.lastReportedTotal = Math.max(state.lastReportedTotal, nextTotal);

  return { inputTokens: dInput, outputTokens: dOutput, totalTokens: dTotal };
}
