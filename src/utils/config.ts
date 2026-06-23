import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export interface DocRelConfig {
  project: string;
  doc_dirs: string[];
  code_dirs: string[];
  strategies: {
    inline: 'auto_update' | 'mark_stale';
    standalone: 'auto_update' | 'mark_stale' | 'prompt';
    generated: 'auto_update' | 'mark_stale';
    architecture: 'mark_stale' | 'ignore';
  };
  codegraph?: {
    command?: string;
    mcpServerName?: string;
  };
}

const userConfigSchema = z.object({
  project: z.string().optional(),
  doc_dirs: z.array(z.string()).optional(),
  code_dirs: z.array(z.string()).optional(),
  strategies: z.object({
    inline: z.enum(['auto_update', 'mark_stale']).optional(),
    standalone: z.enum(['auto_update', 'mark_stale', 'prompt']).optional(),
    generated: z.enum(['auto_update', 'mark_stale']).optional(),
    architecture: z.enum(['mark_stale', 'ignore']).optional(),
  }).optional(),
  codegraph: z.object({
    command: z.string().optional(),
    mcpServerName: z.string().optional(),
  }).optional(),
});

// NOTE: 'project' is intentionally NOT in DEFAULT_CONFIG — it is always
// computed from projectRoot in loadConfig to avoid stale process.cwd() values
// captured at module import time.
const DEFAULT_CONFIG: Omit<DocRelConfig, 'project'> = {
  doc_dirs: ['docs', 'README.md'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'auto_update',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

export function loadConfig(projectRoot: string): DocRelConfig {
  if (!projectRoot) throw new Error('projectRoot is required — cannot load config without a project root');
  const configPath = path.join(projectRoot, '.docrel', 'config.yaml');
  const project = path.basename(projectRoot) || 'unknown-project';

  if (!fs.existsSync(configPath)) {
    return { project, ...DEFAULT_CONFIG };
  }

  const configRelPath = `.docrel/config.yaml`;

  let userConfig: Partial<DocRelConfig>;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    const result = userConfigSchema.safeParse(parsed);
    if (!result.success) {
      console.error(`Warning: Invalid config in ${configRelPath}: ${result.error.message}. Using defaults.`);
      return { project, ...DEFAULT_CONFIG };
    }
    userConfig = result.data as Partial<DocRelConfig>;
  } catch (err: any) {
    // Log the relative config path plus sanitized error details. YAML parse
    // errors from the 'yaml' library typically mention line/column numbers,
    // not filesystem paths, so including err.message is safe and dramatically
    // improves debuggability. Strip any absolute path references as a precaution.
    const sanitizedMsg = (err instanceof Error ? err.message : String(err))
      .replace(projectRoot, '<projectRoot>')
      .replace(/\/(?:home|opt|var|etc|tmp)\/[^\s:,)]*/g, '<path>');
    console.error(`Warning: Failed to load ${configRelPath}: ${sanitizedMsg}. Using defaults.`);
    return { project, ...DEFAULT_CONFIG };
  }

  return {
    project: userConfig.project ?? project,
    ...DEFAULT_CONFIG,
    ...userConfig,
    strategies: { ...DEFAULT_CONFIG.strategies, ...userConfig.strategies },
    codegraph: { ...DEFAULT_CONFIG.codegraph, ...userConfig.codegraph },
  };
}
