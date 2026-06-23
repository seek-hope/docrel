import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

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

const DEFAULT_CONFIG: DocRelConfig = {
  project: path.basename(process.cwd()),
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
  const configPath = path.join(projectRoot, '.docrel', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, project: path.basename(projectRoot) };
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const userConfig = parseYaml(raw) as Partial<DocRelConfig>;

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    strategies: { ...DEFAULT_CONFIG.strategies, ...userConfig.strategies },
    codegraph: { ...DEFAULT_CONFIG.codegraph, ...userConfig.codegraph },
  };
}
