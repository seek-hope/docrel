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
// Only allow documentation generators — NOT general-purpose interpreters.
// Retaining interpreters (bash, sh, node, tsx, npx, python, python3, make, cargo)
// would enable arbitrary code execution from package.json scripts, which is a
// supply-chain risk for CI pipelines when strategies.generated: auto_update is active.
const ALLOWED_BINARIES = new Set([
  'typedoc', 'openapi-generator',
]);

/**
 * Split a generator command string into [binary, ...args].
 * The command is expected to be a safe space-delimited command without shell metacharacters.
 * Validation happens in two layers:
 *   1. ALLOWED_BINARIES: rejects binaries not on the allowlist (first line of defense).
 *   2. Full-command prefix check: prevents option injection (e.g. `typedoc --evil-flag`).
 *      Currently redundant with the allowlist alone, but provides defense-in-depth
 *      when the allowlist is expanded in the future.
 */
function splitCommand(cmd: string): { binary: string; args: string[] } | null {
  // Reject commands with shell metacharacters, including \r (CR), \t (TAB),
  // and \x00 (null byte) which would bypass the \s split downstream.
  if (/[;&|`$()\n\r\t\x00<>!]/.test(cmd)) return null;
  if (cmd.length > MAX_COMMAND_LENGTH) return null;
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0) return null;
  if (parts.length > MAX_ARGS + 1) return null;

  const binary = parts[0];
  // Reject relative paths and absolute paths — allow only known binaries
  if (binary.includes('/') || binary.includes('\\')) {
    return null; // reject path-based commands
  }
  // Validate against binary allowlist
  if (!ALLOWED_BINARIES.has(binary)) {
    return null;
  }

  // Validate the full command starts with an allowed prefix to prevent
  // option injection attacks through package.json scripts.
  // This is defense-in-depth: ALLOWED_BINARIES already rejects unknown binaries,
  // but when the allowlist is expanded with scripts like `tsx scripts/generate-docs.ts`,
  // the prefix check also validates the full command.
  const fullCmd = cmd.trim();
  const ALLOWED_PREFIXES: RegExp[] = [
    /^typedoc(?:\s|$)/,
    /^openapi-generator(?:\s|$)/,
  ];
  if (!ALLOWED_PREFIXES.some((prefix) => prefix.test(fullCmd))) {
    return null;
  }

  return { binary, args: parts.slice(1) };
}

export function updateGeneratedDoc(input: GeneratedSyncInput): { success: boolean; output: string } {
  const split = splitCommand(input.generator);
  if (!split) {
    console.error('DocRel: generator command rejected by security validation:', input.generator);
    return { success: false, output: 'Generator command rejected by security validation — check server logs for details' };
  }

  try {
    const result = spawnSync(split.binary, split.args, {
      cwd: input.projectRoot,
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB output limit
    });
    if (result.error) {
      // Log the full/truncated output to stderr for diagnostics, but return
      // only a minimal message to MCP clients. Generator output may contain
      // absolute filesystem paths, internal configuration, or other sensitive
      // data that should not be exposed in structured API responses.
      const fullOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const truncated = fullOutput ? fullOutput.slice(-500) : '';
      if (fullOutput) console.error('DocRel: generator error output (truncated):', truncated);
      return {
        success: false,
        output: `Generator failed: ${result.error.message}`,
      };
    }
    if (result.status !== 0) {
      const fullOutput = [result.stderr, result.stdout].filter(Boolean).join('\n') || `exit code ${result.status}`;
      const truncated = fullOutput.slice(-500);
      console.error('DocRel: generator non-zero exit:', truncated);
      return {
        success: false,
        output: `Generator exited with code ${result.status} — check server logs for details`,
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

  // Use fd-based size check before reading to prevent OOM
  // from malicious or accidentally large package.json files.
  let raw: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(pkgPath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size > 1_048_576) {
      console.error('Warning: package.json exceeds 1MB, skipping generator detection');
      return null;
    }
    raw = fs.readFileSync(fd, 'utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }

  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch (err: any) {
    console.error(`Warning: Failed to parse ${pkgPath}: ${err.message}`);
    return null;
  }
  const scripts = pkg.scripts ?? {};

  // Only treat YAML files as OpenAPI specs when there are additional signals:
  // the filename or path includes 'openapi', 'swagger', or the file is inside
  // a known API docs directory. This prevents files like config.yaml or ci.yaml
  // from incorrectly triggering OpenAPI generator detection.
  const isOpenApiFile = (file.endsWith('.yaml') || file.endsWith('.yml')) && (
    file.toLowerCase().includes('openapi') ||
    file.toLowerCase().includes('swagger') ||
    /\/api[-\/]?(docs|spec|schema)/i.test(file)
  );
  if (isOpenApiFile) {
    const cmd = scripts['generate:api'] ?? scripts['generate:openapi'];
    if (typeof cmd !== 'string') return null;
    if (scripts['generate:api'] && scripts['generate:openapi']) {
      console.warn(`DocRel: Both generate:api and generate:openapi found in package.json — using generate:api for ${file}`);
    }
    // Validate it's a safe command (no shell metacharacters)
    if (/[;&|`$()\n\r\t\x00<>!]/.test(cmd)) return null;
    if (cmd.length > MAX_COMMAND_LENGTH) return null;
    return cmd;
  }

  if ((file.endsWith('.md') && file.includes('typedoc')) || (file.endsWith('.md') && scripts['docs:generate'] &&
      (file.includes('/docs/api/') || file.includes('/docs/generated/') || file.includes('/typedoc/') || file.includes('/reference/')))) {
    const cmd = scripts['docs:generate'];
    if (typeof cmd !== 'string') return null;
    if (/[;&|`$()\n\r\t\x00<>!]/.test(cmd)) return null;
    if (cmd.length > MAX_COMMAND_LENGTH) return null;
    return cmd;
  }

  return null;
}
