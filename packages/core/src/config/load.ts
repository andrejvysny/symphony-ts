import path from 'node:path';
import { ConfigError } from '@symphony/shared';
import { loadWorkflowFile } from '../workflow/loader.js';
import { parseConfig, resolveConfig, type SymphonyConfig } from './resolve.js';

export interface LoadedConfig {
  config: SymphonyConfig;
  promptBody: string;
  filePath: string;
}

/** Load + parse + resolve a WORKFLOW.md into runtime config (SPEC §5–6). */
export async function loadConfig(filePath: string): Promise<LoadedConfig> {
  const wf = await loadWorkflowFile(filePath);
  let config: SymphonyConfig;
  try {
    const parsed = parseConfig(wf.frontMatter);
    config = resolveConfig(parsed, path.dirname(wf.filePath));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`invalid workflow config: ${(e as Error).message}`);
  }
  return { config, promptBody: wf.promptBody, filePath: wf.filePath };
}
