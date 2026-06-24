import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { escapeRegex } from './fs.js';

/** Current config schema version. Increment on breaking changes. */
export const CONFIG_SCHEMA_VERSION = 1;

export interface DocRelayConfig {
  /** Config schema version for migration support. */
  version: number;
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
    /** Maximum number of files to request per directory from codegraph_explore.
     *  Default 50. Increase for large codebases (e.g. 200 for monorepos). */
    maxFiles?: number;
  };
}

const userConfigSchema = z.object({
  version: z.number().int().min(1).optional(),
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
    maxFiles: z.number().int().min(1).max(500).optional(),
  }).optional(),
});

// NOTE: 'project' is intentionally NOT in DEFAULT_CONFIG — it is always
// computed from projectRoot in loadConfig to avoid stale process.cwd() values
// captured at module import time.
const DEFAULT_CONFIG: Omit<DocRelayConfig, 'project' | 'version'> = {
  doc_dirs: ['docs', 'README.md'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'auto_update',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

export function loadConfig(projectRoot: string): DocRelayConfig {
  if (!projectRoot || !projectRoot.trim()) throw new Error('projectRoot is required — cannot load config without a project root');
  try {
    if (!fs.statSync(projectRoot).isDirectory()) throw new Error(`projectRoot is not a directory: ${projectRoot}`);
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`projectRoot does not exist: ${projectRoot}`);
    }
    throw err;
  }
  const configPath = path.join(projectRoot, '.docrelay', 'config.yaml');
  const project = path.basename(projectRoot) || 'unknown-project';

  if (!fs.existsSync(configPath)) {
    return { version: CONFIG_SCHEMA_VERSION, project, ...DEFAULT_CONFIG };
  }

  const configRelPath = `.docrelay/config.yaml`;

  let userConfig: Partial<DocRelayConfig>;

  try {
    // Guard against maliciously large config files that could OOM the process
    // before YAML parsing begins. A real config is typically under 1 KB;
    // 1 MB is extremely generous and prevents accidentally large files.
    const MAX_CONFIG_SIZE = 1_048_576; // 1 MB
    const configStat = fs.statSync(configPath);
    if (configStat.size > MAX_CONFIG_SIZE) {
      console.error(`Warning: .docrelay/config.yaml exceeds ${MAX_CONFIG_SIZE} bytes — using defaults.`);
      return { version: CONFIG_SCHEMA_VERSION, project, ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    // Pre-check version before Zod validation: a version < CONFIG_SCHEMA_VERSION
    // (e.g. 0 from an older release) will fail the schema's min(1) check,
    // which would discard ALL user config in favor of defaults.
    // Instead, warn once and strip the version field so other config keys
    // can still be validated and merged.
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const pv = (parsed as Record<string, unknown>).version;
      if (typeof pv === 'number' && pv < CONFIG_SCHEMA_VERSION) {
        console.error(`Warning: Config schema version ${pv} is older than ${CONFIG_SCHEMA_VERSION}. Migrating config fields — update .docrelay/config.yaml to version: ${CONFIG_SCHEMA_VERSION} when convenient.`);
        delete (parsed as Record<string, unknown>).version;
      }
    }
    const result = userConfigSchema.safeParse(parsed);
    if (!result.success) {
      console.error(`Warning: Invalid config in ${configRelPath}: ${result.error.message}. Using defaults.`);
      return { version: CONFIG_SCHEMA_VERSION, project, ...DEFAULT_CONFIG };
    }
    userConfig = result.data as Partial<DocRelayConfig>;
  } catch (err: any) {
    // Log the relative config path plus sanitized error details. YAML parse
    // errors from the 'yaml' library typically mention line/column numbers,
    // not filesystem paths, so including err.message is safe and dramatically
    // improves debuggability. Strip any absolute path references as a precaution.
    const sanitizedMsg = (err instanceof Error ? err.message : String(err))
      .replace(new RegExp(escapeRegex(projectRoot), 'g'), '<projectRoot>')
      .replace(/\/(?:home|opt|var|etc|tmp)\/[^\s:,)]*/g, '<path>');
    console.error(`Warning: Failed to load ${configRelPath}: ${sanitizedMsg}. Using defaults.`);
    return { version: CONFIG_SCHEMA_VERSION, project, ...DEFAULT_CONFIG };
  }

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    project: userConfig.project ?? project,
    version: userConfig.version ?? CONFIG_SCHEMA_VERSION,
    strategies: { ...DEFAULT_CONFIG.strategies, ...userConfig.strategies },
    codegraph: { ...DEFAULT_CONFIG.codegraph, ...userConfig.codegraph },
  };
}

export interface ConfigValidationIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Pre-flight config validation. Checks for common misconfigurations and
 * returns actionable diagnostic messages. Call before scanning.
 */
export function validateConfig(config: DocRelayConfig, projectRoot: string): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  // Version check — warn if config is from a future version
  if (config.version > CONFIG_SCHEMA_VERSION) {
    issues.push({
      field: 'version',
      severity: 'warning',
      message: `Config schema version ${config.version} is newer than DocRelay's supported version ${CONFIG_SCHEMA_VERSION}. Some features may not work. Consider upgrading DocRelay.`,
    });
  }

  // Code directories must exist
  const root = path.resolve(projectRoot);
  for (const dir of config.code_dirs) {
    const absDir = path.resolve(projectRoot, dir);
    // Containment check: reject config values that escape projectRoot.
    // A malicious .docrelay/config.yaml could specify code_dirs: ['/etc'] to
    // probe filesystem paths outside the project via existsSync.
    if (!absDir.startsWith(root + path.sep) && absDir !== root) {
      issues.push({
        field: `code_dirs.${dir}`,
        severity: 'error',
        message: `Code directory '${dir}' is outside project root — rejected for safety.`,
      });
      continue;
    }
    if (!fs.existsSync(absDir)) {
      issues.push({
        field: `code_dirs.${dir}`,
        severity: 'error',
        message: `Code directory '${dir}' does not exist. Create it or update code_dirs in .docrelay/config.yaml.`,
      });
    }
  }

  // Doc directories must exist
  for (const dir of config.doc_dirs) {
    const absPath = path.resolve(projectRoot, dir);
    if (!absPath.startsWith(root + path.sep) && absPath !== root) {
      issues.push({
        field: `doc_dirs.${dir}`,
        severity: 'error',
        message: `Doc path '${dir}' is outside project root — rejected for safety.`,
      });
      continue;
    }
    if (!fs.existsSync(absPath)) {
      issues.push({
        field: `doc_dirs.${dir}`,
        severity: 'warning',
        message: `Doc path '${dir}' does not exist. Create it or update doc_dirs in .docrelay/config.yaml.`,
      });
    }
  }

  // At least one code directory should be configured
  if (config.code_dirs.length === 0) {
    issues.push({
      field: 'code_dirs',
      severity: 'error',
      message: 'No code_dirs configured. Add at least one directory (e.g., src) to .docrelay/config.yaml.',
    });
  }

  return issues;
}
