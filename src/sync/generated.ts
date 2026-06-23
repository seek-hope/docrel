// src/sync/generated.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GeneratedSyncInput {
  file: string;
  generator: string;  // e.g. "typedoc", "openapi-generator", "tsx scripts/generate-docs.ts"
  projectRoot: string;
}

/**
 * Split a generator command string into [binary, ...args].
 * The command is expected to be a safe space-delimited command without shell metacharacters.
 */
function splitCommand(cmd: string): { binary: string; args: string[] } | null {
  // Reject commands with shell metacharacters
  if (/[;&|`$()]/.test(cmd)) return null;
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0) return null;
  return { binary: parts[0], args: parts.slice(1) };
}

export function updateGeneratedDoc(input: GeneratedSyncInput): { success: boolean; output: string } {
  const split = splitCommand(input.generator);
  if (!split) {
    return { success: false, output: `Unsafe or empty generator command: ${input.generator}` };
  }

  try {
    const result = spawnSync(split.binary, split.args, {
      cwd: input.projectRoot,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    if (result.error) {
      return { success: false, output: result.error.message };
    }
    if (result.status !== 0) {
      return { success: false, output: result.stderr || result.stdout || `exit code ${result.status}` };
    }
    return { success: true, output: result.stdout };
  } catch (err: any) {
    return { success: false, output: err.message };
  }
}

export function detectGenerator(file: string, projectRoot: string): string | null {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  // Reject large package.json files (DoS protection)
  try {
    const stat = fs.statSync(pkgPath);
    if (stat.size > 1_048_576) {
      console.error('Warning: package.json exceeds 1MB, skipping generator detection');
      return null;
    }
  } catch {
    return null;
  }

  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch (err: any) {
    console.error(`Warning: Failed to parse ${pkgPath}: ${err.message}`);
    return null;
  }
  const scripts = pkg.scripts ?? {};

  if (file.endsWith('.yaml') || file.endsWith('.yml') || file.includes('openapi')) {
    const cmd = scripts['generate:api'] ?? scripts['generate:openapi'];
    if (typeof cmd !== 'string') return null;
    // Validate it's a safe command (no shell metacharacters)
    if (/[;&|`$()]/.test(cmd)) return null;
    return cmd;
  }

  if (file.includes('typedoc') || (file.endsWith('.md') && scripts['docs:generate'])) {
    const cmd = scripts['docs:generate'];
    if (typeof cmd !== 'string') return null;
    if (/[;&|`$()]/.test(cmd)) return null;
    return cmd;
  }

  return null;
}
