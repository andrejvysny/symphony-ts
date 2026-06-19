import { describe, expect, it } from 'vitest';
import {
  supportsBoard,
  supportsIssueCreation,
  supportsIssueRemoval,
  supportsIssueWriter,
} from '../tracker.js';
import { NullTracker } from './null-tracker.js';

describe('NullTracker', () => {
  it('is an inert read/board tracker with no write/create/remove capability', async () => {
    const t = new NullTracker();
    expect(t.kind).toBe('none');
    // Reads resolve empty (orchestrator idles; dashboard board renders nothing).
    expect(await t.fetchCandidateIssues()).toEqual([]);
    expect(await t.fetchIssuesByStates()).toEqual([]);
    expect(await t.fetchIssueStatesByIds()).toEqual([]);
    expect(await t.fetchAllIssues()).toEqual([]);
    expect(await t.listWorkflowStates()).toEqual([]);
    expect(await t.listLabels()).toEqual([]);
    // Board capability yes (empty), but no writes/creation/removal → dashboard `write` cap is false.
    expect(supportsBoard(t)).toBe(true);
    expect(supportsIssueWriter(t)).toBe(false);
    expect(supportsIssueCreation(t)).toBe(false);
    expect(supportsIssueRemoval(t)).toBe(false);
  });
});
