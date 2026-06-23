// src/sync/generated.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GeneratedSyncInput {
  file: string;
  generator: string;  // e.g. "typedoc", "openapi-generator", "tsx scripts/generate-docs.ts"
  projectRoot: string;
}

const MAX_COMMAND_LENGTH = 1024;
const MAX_ARGS = 50;
// Allowlisting safe known tools avoids allowing arbitrary binaries to run
const ALLOWED_BINARIES = new Set([
  'tsx', 'node', 'typedoc', 'openapi-generator', 'npx', 'npm',
  'yarn', 'pnpm', 'bash', 'sh', 'python', 'python3', 'make', 'cargo',
]);

/**
 * Split a generator command string into [binary, ...args].
 * The command is expected to be a safe space-delimited command without shell metacharacters.
 */
function splitCommand(cmd: string): { binary: string; args: string[] } | null {
  // Reject commands with shell metacharacters
  if (/[;&|`$()]/.test(cmd)) return null;
  if (cmd.length > MAX_COMMAND_LENGTH) return null;
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0) return null;
  if (parts.length > MAX_ARGS + 1) return null;

  const binary = parts[0];
  // Reject relative paths and absolute paths — allow only known binaries
  if (binary.includes('/') || binary.includes('\\')) {
    return null; // reject path-based commands
  }
  // Validate against allowlist
  if (!ALLOWED_BINARIES.has(binary)) {
    return null;
  }

  return { binary, args: parts.slice(1) };
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
      maxBuffer: 10 * 1024 * 1024, // 10 MB output limit
    });
    if (result.error) {
      // Always include available output alongside the error message
      const extra = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return { success: false, output: extra ? `${result.error.message}\n${extra}` : result.error.message };
    }
    if (result.status !== 0) {
      // Include both stdout and stderr for debugging failures
      return {
        success: false,
        output: [result.stderr, result.stdout].filter(Boolean).join('\n') || `exit code ${result.status}`,
      };
    }
    return { success: true, output: result.stdout };
  } catch (err: any) {
    return { success: false, output: err.message };
  }
}

export function detectGenerator(file: string, projectRoot: string): string | null {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  // Read file first, then check size (avoid TOCTOU between stat and read)
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, 'utf-8');
  } catch {
    return null;
  }

  if (raw.length > 1_048_576) {
    console.error('Warning: package.json exceeds 1MB, skipping generator detection');
    return null;
  }

  let pkg: any;
  try {
    pkg = JSON.parse(raw);
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
    if (cmd.length > MAX_COMMAND_LENGTH) return null;
    return cmd;
  }

  if (file.includes('typedoc') || (file.endsWith('.md') && scripts['docs:generate'])) {
    const cmd = scripts['docs:generate'];
    if (typeof cmd !== 'string') return null;
    if (/[;&|`$()]/.test(cmd)) return null;
    if (cmd.length > MAX_COMMAND_LENGTH) return null;
    return cmd;
  }

  return null;
}
