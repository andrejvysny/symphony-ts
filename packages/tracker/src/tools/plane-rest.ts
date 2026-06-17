export type RestMethod = 'GET' | 'POST' | 'PATCH';

export interface TrackerApiArgs {
  method: RestMethod;
  /** Project-relative path, e.g. `/work-items/` or `/work-items/{id}/comments/`. */
  path: string;
  body?: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
}

export type RestFn = (
  method: RestMethod,
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

const METHODS = new Set<RestMethod>(['GET', 'POST', 'PATCH']);

/**
 * Sub-resources the agent may touch, relative to the configured project base. The client
 * prepends `/workspaces/{slug}/projects/{id}`, so a valid path is relative to *this* project.
 */
const ALLOWED_PREFIXES = [
  '/work-items',
  '/issues', // legacy alias of /work-items (deprecated, still accepted)
  '/states',
  '/labels',
  '/cycles',
  '/modules',
  '/members',
];

/**
 * Validate the tool input and confine `path` to the configured project. A raw REST passthrough
 * is powerful, so this is the security boundary: it rejects absolute URLs, traversal, attempts
 * to re-root into another workspace/project, and non-allowlisted resources. Defense in depth —
 * the client also prepends a fixed project base, so only the suffix is agent-controlled.
 */
export function validateArgs(
  input: unknown,
): { ok: true; args: TrackerApiArgs } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null)
    return { ok: false, error: 'input must be an object' };
  const obj = input as Record<string, unknown>;

  const method = obj['method'];
  if (typeof method !== 'string' || !METHODS.has(method as RestMethod))
    return { ok: false, error: 'method must be one of GET, POST, PATCH' };

  const path = obj['path'];
  if (typeof path !== 'string' || path.trim().length === 0)
    return { ok: false, error: 'path must be a non-empty string' };

  const body = obj['body'];
  if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body)))
    return { ok: false, error: 'body must be an object' };

  // Strip the query string before structural checks (it is allowed and passed through).
  const bare = path.split('?')[0] ?? '';

  if (!bare.startsWith('/')) return { ok: false, error: 'path must start with "/"' };
  if (bare.startsWith('//')) return { ok: false, error: 'path must not start with "//"' };
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.includes('\\'))
    return { ok: false, error: 'path must be a project-relative path, not a URL' };
  if (/%2e|%2f/i.test(path))
    return { ok: false, error: 'path must not contain encoded separators' };

  const norm = bare.replace(/\/{2,}/g, '/');
  const segments = norm.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..'))
    return { ok: false, error: 'path must not contain "." or ".." segments' };
  if (segments.some((s) => s === 'api' || s === 'workspaces' || s === 'projects'))
    return { ok: false, error: 'path must stay within the configured project' };

  if (!ALLOWED_PREFIXES.some((p) => norm === p || norm.startsWith(`${p}/`)))
    return { ok: false, error: `path must address one of: ${ALLOWED_PREFIXES.join(', ')}` };

  return {
    ok: true,
    args: {
      method: method as RestMethod,
      path,
      ...(body !== undefined ? { body: body as Record<string, unknown> } : {}),
    },
  };
}

/**
 * Build a transport-neutral `tracker_api` executor (a confined REST passthrough to Plane).
 * Reused by both the in-process Claude SDK MCP tool and the standalone stdio MCP server.
 */
export function makePlaneRestExecutor(restFn: RestFn): (input: unknown) => Promise<ToolResult> {
  return async (input: unknown): Promise<ToolResult> => {
    const validated = validateArgs(input);
    if (!validated.ok)
      return { success: false, output: JSON.stringify({ error: validated.error }) };
    try {
      const data = await restFn(validated.args.method, validated.args.path, validated.args.body);
      return { success: true, output: JSON.stringify({ data: data ?? null }) };
    } catch (e) {
      return { success: false, output: JSON.stringify({ error: (e as Error).message }) };
    }
  };
}
