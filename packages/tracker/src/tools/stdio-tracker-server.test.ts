import { describe, expect, it, vi } from 'vitest';
import { buildStdioTrackerServer, type TrackerStdioToolDeps } from './stdio-tracker-server.js';
import type { ToolResult } from './plane-rest.js';

function okExec() {
  return vi
    .fn<(input: unknown) => Promise<ToolResult>>()
    .mockResolvedValue({ success: true, output: JSON.stringify({ data: { ok: true } }) });
}

function deps(over: Partial<TrackerStdioToolDeps> = {}): TrackerStdioToolDeps {
  return {
    getTask: okExec(),
    updateStatus: okExec(),
    addComment: okExec(),
    allowedStates: ['Todo', 'In Progress', 'Human Review'],
    ...over,
  };
}

function registered(
  server: unknown,
): Record<string, { handler: (a: unknown) => Promise<unknown> }> {
  return (
    server as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> }
  )._registeredTools;
}

describe('buildStdioTrackerServer', () => {
  it('registers the three semantic tracker tools (no tracker_api by default)', () => {
    const tools = registered(buildStdioTrackerServer(deps()));
    expect(Object.keys(tools).sort()).toEqual([
      'tracker_add_comment',
      'tracker_get_task',
      'tracker_update_status',
    ]);
  });

  it('exposes tracker_api only when a rawApi executor is provided', () => {
    const rawApi = okExec();
    const tools = registered(buildStdioTrackerServer(deps({ rawApi })));
    expect(Object.keys(tools)).toContain('tracker_api');
  });

  it('routes a call to the matching executor and wraps the output as text content', async () => {
    const getTask = vi.fn<(i: unknown) => Promise<ToolResult>>().mockResolvedValue({
      success: true,
      output: JSON.stringify({ data: { title: 'Add login' } }),
    });
    const tools = registered(buildStdioTrackerServer(deps({ getTask })));
    const res = (await tools['tracker_get_task']?.handler({ task_id: 'abc' })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(getTask).toHaveBeenCalledWith({ task_id: 'abc' });
    expect(res.content[0]?.type).toBe('text');
    expect(res.content[0]?.text).toContain('Add login');
    expect(res.isError).toBe(false);
  });

  it('sets isError:true when an executor returns success:false', async () => {
    const updateStatus = vi
      .fn<(i: unknown) => Promise<ToolResult>>()
      .mockResolvedValue({ success: false, output: JSON.stringify({ error: 'nope' }) });
    const tools = registered(buildStdioTrackerServer(deps({ updateStatus })));
    const res = (await tools['tracker_update_status']?.handler({
      task_id: 'abc',
      status: 'Todo',
    })) as { content: Array<{ text: string }>; isError: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('nope');
  });
});
