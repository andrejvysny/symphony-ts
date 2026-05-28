import { describe, expect, it } from 'vitest';
import { LinearTracker } from './adapter.js';

/**
 * Opt-in live test against the real Linear API. Skipped unless:
 *   SYMPHONY_E2E=1  LINEAR_API_KEY=...  SYMPHONY_E2E_PROJECT=<slug>
 * Read-only: fetches candidate issues for the project and asserts the shape.
 */
const enabled = process.env['SYMPHONY_E2E'] === '1' && Boolean(process.env['LINEAR_API_KEY']);

describe.skipIf(!enabled)('LinearTracker (live)', () => {
  it('fetches candidate issues from the configured project', async () => {
    const tracker = new LinearTracker({
      endpoint: 'https://api.linear.app/graphql',
      apiKey: process.env['LINEAR_API_KEY']!,
      projectSlug: process.env['SYMPHONY_E2E_PROJECT'] ?? '',
      activeStates: ['Todo', 'In Progress'],
    });
    const issues = await tracker.fetchCandidateIssues();
    expect(Array.isArray(issues)).toBe(true);
    for (const i of issues) {
      expect(typeof i.id).toBe('string');
      expect(typeof i.identifier).toBe('string');
      expect(Array.isArray(i.labels)).toBe(true);
    }
  }, 30_000);
});
