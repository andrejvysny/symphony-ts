import { parse } from 'graphql';
import type { GraphqlResult } from '../linear/client.js';

export interface LinearGraphqlArgs {
  query: string;
  variables?: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
}

export type GraphqlFn = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<GraphqlResult>;

/** Validate the tool input: non-empty query with exactly one operation (SPEC §10.5). */
export function validateArgs(
  input: unknown,
): { ok: true; args: LinearGraphqlArgs } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null)
    return { ok: false, error: 'input must be an object' };
  const obj = input as Record<string, unknown>;
  const query = obj['query'];
  if (typeof query !== 'string' || query.trim().length === 0)
    return { ok: false, error: 'query must be a non-empty string' };
  const variables = obj['variables'];
  if (
    variables !== undefined &&
    (typeof variables !== 'object' || variables === null || Array.isArray(variables))
  )
    return { ok: false, error: 'variables must be an object' };

  let opCount = 0;
  try {
    const doc = parse(query);
    opCount = doc.definitions.filter((d) => d.kind === 'OperationDefinition').length;
  } catch (e) {
    return { ok: false, error: `invalid GraphQL: ${(e as Error).message}` };
  }
  if (opCount !== 1)
    return { ok: false, error: `query must contain exactly one operation (found ${opCount})` };

  return {
    ok: true,
    args: { query, ...(variables ? { variables: variables as Record<string, unknown> } : {}) },
  };
}

/**
 * Build a transport-neutral linear_graphql executor. Reused by both the in-process
 * Claude SDK MCP tool and the standalone stdio MCP server for CLI backends.
 */
export function makeLinearGraphqlExecutor(
  graphqlFn: GraphqlFn,
): (input: unknown) => Promise<ToolResult> {
  return async (input: unknown): Promise<ToolResult> => {
    const validated = validateArgs(input);
    if (!validated.ok)
      return { success: false, output: JSON.stringify({ error: validated.error }) };
    try {
      const res = await graphqlFn(validated.args.query, validated.args.variables ?? {});
      if (res.errors && res.errors.length > 0) {
        return { success: false, output: JSON.stringify(res) };
      }
      return { success: true, output: JSON.stringify(res) };
    } catch (e) {
      return { success: false, output: JSON.stringify({ error: (e as Error).message }) };
    }
  };
}
