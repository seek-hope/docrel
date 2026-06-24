// src/sync/generated.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateCommandSafety } from '../utils/command.js';

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

// Package.json script names that are safe to run via `npm run <script>`.
// npm handles path resolution and node_modules/.bin lookup, so scripts using
// any tool (tsx, node, typedoc, openapi-generator, custom CLI) work without
// the binary needing to be in ALLOWED_BINARIES. This is both more secure
// (npm enforces the exact script defined in package.json) and more flexible
// (works with any documentation generation tool).
const ALLOWED_SCRIPTS = new Set([
  'docs:generate',
  'generate:docs',
  'build:docs',
  'docs:build',
  'generate:api',
  'generate:openapi',
]);

/** Return the `npm run <script>` command to use when a matching allowed script
 *  is found in package.json scripts. Returns null if no match or if safety
 *  checks fail.
 *
 *  @param preferredScripts — checked first before the default ALLOWED_SCRIPTS
 *  order. Use this to ensure type-specific scripts win over generic ones
 *  (e.g., `generate:openapi` for OpenAPI specs, `docs:generate` for TypeDoc). */
function resolveNpmScript(scripts: Record<string, string>, preferredScripts?: string[]): string | null {
  const order = preferredScripts ? [...preferredScripts, ...ALLOWED_SCRIPTS] : ALLOWED_SCRIPTS;
  for (const scriptName of order) {
    if (typeof scripts[scriptName] === 'string') {
      // The script value is not validated beyond being a non-empty string —
      // npm handles the actual execution, and the script is already defined
      // in the project's own package.json (not injected by DocRel).
      const cmd = scripts[scriptName].trim();
      if (cmd.length === 0) continue;
      return `npm run ${scriptName}`;
    }
  }
  return null;
}

/**
 * Split a generator command string into [binary, ...args].
 * The command is expected to be a safe space-delimited command without shell metacharacters.
 * Validation happens in two layers:
 *   1. ALLOWED_BINARIES: rejects binaries not on the allowlist (first line of defense).
 *   2. Full-command prefix check: prevents option injection (e.g. `typedoc --evil-flag`).
 *      Currently redundant with the allowlist alone, but provides defense-in-depth
 *      when the allowlist is expanded in the future.
 *   3. Flag-level validation: rejects typedoc's code-loading flags (--plugin, --options,
 *      --tsconfig) which could be used for arbitrary code execution through a crafted
 *      package.json.
 */
function splitCommand(cmd: string): { binary: string; args: string[] } | null {
  if (!validateCommandSafety(cmd)) return null;
  // F24: Defensive guard — validateCommandSafety rejects empty strings and
  // strings with shell metacharacters, but if validation is relaxed in the
  // future, a whitespace-only string could produce empty parts after trim.
  if (!cmd.trim()) return null;
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0) return null;
  if (parts.length > MAX_ARGS + 1) return null;

  const binary = parts[0];

  // ── npm run <script> path ──────────────────────────────────────────
  // When the command is `npm run <script>`, validate the script name
  // against ALLOWED_SCRIPTS. npm handles path resolution and enforces
  // the exact script defined in package.json.
  if (binary === 'npm') {
    if (parts.length < 3) return null;
    if (parts[1] !== 'run') return null;
    const scriptName = parts[2];
    if (!ALLOWED_SCRIPTS.has(scriptName)) {
      console.error(`DocRel: npm run script '${scriptName}' is not in the allowed scripts list`);
      return null;
    }
    // Reject extra arguments — only `npm run <allowed_script>` is permitted.
    // This prevents `npm run docs:generate -- --evil-flag` injection.
    if (parts.length > 3) {
      console.error('DocRel: npm run command rejected — extra arguments not allowed');
      return null;
    }
    return { binary: 'npm', args: ['run', scriptName] };
  }

  // ── Direct binary path ─────────────────────────────────────────────
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
  const fullCmd = cmd.trim();
  const ALLOWED_PREFIXES: RegExp[] = [
    /^typedoc(?:\s|$)/,
    /^openapi-generator(?:\s|$)/,
  ];
  if (!ALLOWED_PREFIXES.some((prefix) => prefix.test(fullCmd))) {
    return null;
  }

  // Reject typedoc code-loading flags that could execute arbitrary JS/TS.
  // --plugin loads arbitrary modules; --options loads a config file that
  // can specify plugins; --tsconfig can reference a crafted tsconfig.
  // A malicious package.json could specify `typedoc --plugin ./evil.ts`
  // which would run arbitrary code during documentation generation.
  if (binary === 'typedoc') {
    const genArgs = parts.slice(1);
    for (const arg of genArgs) {
      if (arg === '--plugin' || arg === '-p' ||
          arg === '--options' || arg === '--tsconfig') {
        console.error('DocRel: typedoc generator command rejected — contains code-loading flag:', arg);
        return null;
      }
      if (/^--plugin=/.test(arg) || /^-p=/.test(arg) ||
          /^--options=/.test(arg) || /^--tsconfig=/.test(arg)) {
        console.error('DocRel: typedoc generator command rejected — contains code-loading flag:', arg);
        return null;
      }
    }
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
      // F6: Use consistent labeled ordering for both error paths.
      // Always put stderr first (where most diagnostic output appears),
      // then stdout. Label each section so operators know what's what.
      const fullOutput = ['[stderr]', result.stderr, '[stdout]', result.stdout].filter(Boolean).join('\n');
      const truncated = fullOutput ? fullOutput.slice(-500) : '';
      if (fullOutput) console.error('DocRel: generator error output (truncated):', truncated);
      return {
        success: false,
        output: `Generator failed: ${result.error.message}`,
      };
    }
    if (result.status !== 0) {
      const fullOutput = ['[stderr]', result.stderr, '[stdout]', result.stdout].filter(Boolean).join('\n') || `exit code ${result.status}`;
      const truncated = fullOutput.slice(-500);
      console.error('DocRel: generator non-zero exit:', truncated);
      return {
        success: false,
        output: `Generator exited with code ${result.status} — check server logs for details`,
      };
    }
    return { success: true, output: result.stdout };
  } catch (err: any) {
    console.error('DocRel: updateGeneratedDoc spawn failed:', err instanceof Error ? err.message : err);
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

  // Use a safe JSON parser with depth limit to prevent stack overflow
  // from deeply nested package.json files within the 1MB size limit.
  const MAX_JSON_DEPTH = 100;
  let pkg: any;
  try {
    let depth = 0;
    pkg = JSON.parse(raw, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        depth++;
        if (depth > MAX_JSON_DEPTH) {
          throw new Error(`JSON nesting depth exceeds ${MAX_JSON_DEPTH}`);
        }
      }
      return value;
    });
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
    /\/api[-\/]?(docs|spec|schema)/i.test(file) ||
    /\/openapi\//i.test(file)
  );
  // When filename/path heuristics miss (e.g. spec.yaml in a non-standard dir),
  // check the first few non-comment lines for OpenAPI/Swagger version headers.
  if (!isOpenApiFile && (file.endsWith('.yaml') || file.endsWith('.yml'))) {
    // Use fd-based read with a fixed-size buffer to avoid loading the entire
    // file into memory. A large OpenAPI spec (e.g., 200 MB) would be fully
    // read and then 99.5% discarded by .slice(0, 1024).
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(projectRoot, file), 'r');
      const buf = Buffer.alloc(1024);
      const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
      const firstBytes = buf.toString('utf-8', 0, bytesRead);
      if (/^(openapi|swagger):\s*["']?\d/i.test(firstBytes)) {
        // Content confirms this is an OpenAPI spec — try type-specific scripts first
        const npmCmd = resolveNpmScript(scripts, ['generate:openapi', 'generate:api']);
        if (npmCmd) return npmCmd;
        const cmd = scripts['generate:api'] ?? scripts['generate:openapi'];
        if (typeof cmd === 'string' && validateCommandSafety(cmd)) return cmd;
      }
    } catch { /* file unreadable — not an OpenAPI spec for our purposes */ }
    finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
  }
  if (isOpenApiFile) {
    // Prefer type-specific OpenAPI scripts over generic ones
    const npmCmd = resolveNpmScript(scripts, ['generate:openapi', 'generate:api']);
    if (npmCmd) return npmCmd;
    // Fall back to direct command for backwards compatibility
    const cmd = scripts['generate:api'] ?? scripts['generate:openapi'];
    if (typeof cmd !== 'string') return null;
    if (scripts['generate:api'] && scripts['generate:openapi']) {
      console.warn(`DocRel: Both generate:api and generate:openapi found in package.json — using generate:api for ${file}`);
    }
    // Validate it's a safe command (no shell metacharacters, length check)
    if (!validateCommandSafety(cmd)) return null;
    return cmd;
  }

  if ((file.endsWith('.md') && file.includes('typedoc')) || (file.endsWith('.md') && scripts['docs:generate'] &&
      (file.includes('/docs/api/') || file.includes('/docs/generated/') || file.includes('/typedoc/') || file.includes('/reference/')))) {
    // Prefer TypeDoc-specific scripts over generic ones
    const npmCmd = resolveNpmScript(scripts, ['docs:generate', 'generate:docs', 'build:docs', 'docs:build']);
    if (npmCmd) return npmCmd;
    // Fall back to direct command for backwards compatibility
    const cmd = scripts['docs:generate'];
    if (typeof cmd !== 'string') return null;
    if (!validateCommandSafety(cmd)) return null;
    return cmd;
  }

  // General fallback: for any file, check if an ALLOWED_SCRIPTS script exists
  // in package.json. This enables generated doc sync for any documentation
  // generation tool (e.g., tsx scripts/generate-docs.ts) without requiring
  // the binary to be on the ALLOWED_BINARIES list.
  const generalNpmCmd = resolveNpmScript(scripts);
  if (generalNpmCmd) return generalNpmCmd;

  return null;
}
