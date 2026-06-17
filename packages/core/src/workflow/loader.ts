import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigError } from '@symphony/shared';

export interface LoadedWorkflow {
  /** Raw decoded YAML front matter (object) or empty object when absent. */
  frontMatter: unknown;
  /** Trimmed Markdown body used as the Codex/agent prompt template. */
  promptBody: string;
  /** Absolute path the workflow was loaded from. */
  filePath: string;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a WORKFLOW.md string into front matter + body (SPEC §5.2). */
export function parseWorkflowFile(content: string): { frontMatter: unknown; promptBody: string } {
  if (content.startsWith('---')) {
    const m = FRONT_MATTER_RE.exec(content);
    if (!m)
      throw new ConfigError('WORKFLOW.md starts with `---` but front matter is not terminated');
    let decoded: unknown;
    try {
      decoded = YAML.parse(m[1]!) ?? {};
    } catch (e) {
      throw new ConfigError(`invalid YAML front matter: ${(e as Error).message}`);
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new ConfigError('YAML front matter must decode to a map');
    }
    return { frontMatter: decoded, promptBody: content.slice(m[0].length).trim() };
  }
  return { frontMatter: {}, promptBody: content.trim() };
}

/**
 * Serialize front matter + body back into a WORKFLOW.md string (inverse of
 * {@link parseWorkflowFile}). The body is the rendered prompt template; front matter is the raw
 * (pre-resolution) config object so `$VAR` indirection and secrets are never expanded on disk.
 */
export function serializeWorkflowFile(frontMatter: unknown, promptBody: string): string {
  const yaml = YAML.stringify(frontMatter ?? {}).trimEnd();
  return `---\n${yaml}\n---\n\n${promptBody.trim()}\n`;
}

export async function loadWorkflowFile(filePath: string): Promise<LoadedWorkflow> {
  const abs = path.resolve(filePath);
  let content: string;
  try {
    content = await readFile(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read workflow file ${abs}: ${(e as Error).message}`);
  }
  const { frontMatter, promptBody } = parseWorkflowFile(content);
  return { frontMatter, promptBody, filePath: abs };
}
