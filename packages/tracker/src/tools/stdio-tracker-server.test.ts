import { describe, expect, it, vi } from 'vitest';
import { buildStdioTrackerServer } from './stdio-tracker-server.js';
import type { ToolResult } from './plane-rest.js';

describe('buildStdioTrackerServer', () => {
  it('registers a tool named tracker_api', () => {
    const executor = vi.fn<() => Promise<ToolResult>>();
    const server = buildStdioTrackerServer(executor);

    // McpServer stores registered tools in _registeredTools (internal map)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toContain('tracker_api');
  });

  it('routes a valid call to the executor and returns content with text', async () => {
    const executor = vi.fn<(input: unknown) => Promise<ToolResult>>().mockResolvedValue({
      success: true,
      output: JSON.stringify({ data: [{ id: 'state-1' }] }),
    });
    const server = buildStdioTrackerServer(executor);

    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;

    const handler = tools['tracker_api']?.handler;
    expect(handler).toBeDefined();

    const result = (await handler?.({ method: 'GET', path: '/states/' })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(executor).toHaveBeenCalledWith({ method: 'GET', path: '/states/' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('state-1');
    expect(result.isError).toBe(false);
  });

  it('sets isError:true when executor returns success:false', async () => {
    const executor = vi.fn<(input: unknown) => Promise<ToolResult>>().mockResolvedValue({
      success: false,
      output: JSON.stringify({ error: 'something went wrong' }),
    });
    const server = buildStdioTrackerServer(executor);

    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools;

    const handler = tools['tracker_api']?.handler;
    const result = (await handler?.({ method: 'GET', path: '/work-items/' })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('something went wrong');
  });
});
