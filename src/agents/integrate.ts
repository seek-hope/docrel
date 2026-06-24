/**
 * Agent integration — config generation for each supported agent.
 *
 * Generates rules-file sections, MCP server configuration, and shell wrappers
 * so that DocRelay is automatically available in the user's coding agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from './detector.js';

export interface IntegrationResult {
  agent: AgentKind;
  filesCreated: string[];
  summary: string;
}

// ── MCP server entry for .mcp.json ───────────────────────────────────
const DOCRELAY_MCP_ENTRY = {
  docrelay: {
    command: 'npx',
    args: ['docrelay'],
  },
};

// ── CLAUDE.md section ────────────────────────────────────────────────
const CLAUDE_DOCRELAY_SECTION = `

## DocRelay — Code-Documentation Sync

DocRelay tracks code symbols and their linked documentation, keeping everything
in sync as the codebase evolves.

### SessionStart
Run \`docrelay status\` at the beginning of each session to see current
documentation health (symbols tracked, docs linked, stale docs).

### PostToolUse
After using Edit or Write tools, consider whether the change affects
documentation. Run \`docrelay impact <changed-file>\` to see which doc sections
reference the modified code.

### Available MCP Tools
| Tool | Purpose |
|------|---------|
| \`docrelay_status\` | Overall health dashboard (symbols, docs, sync %) |
| \`docrelay_check\` | Find stale documentation sections |
| \`docrelay_impact\` | Show docs affected by changed files |
| \`docrelay_sync\` | Sync docs for a specific symbol |
| \`docrelay_link\` | Create or delete symbol-to-doc mappings |
| \`docrelay_diff\` | Show change history for a symbol |
| \`docrelay_scan\` | Rescan codebase and re-link docs |

### CLI Quick Reference
\`\`\`
docrelay status              # Health dashboard
docrelay check               # Find stale docs
docrelay check --strict      # Exit 1 if any stale docs
docrelay impact src/foo.ts   # What docs are affected?
docrelay sync --symbol <id>  # Sync docs for a symbol
docrelay scan                # Rescan codebase
\`\`\`
`;

// ── OPENCODE.md section ──────────────────────────────────────────────
const OPENCODE_DOCRELAY_SECTION = `

## DocRelay — Code-Documentation Sync

DocRelay tracks code symbols and their linked documentation. Add it as an MCP
server to get documentation health tools in your OpenCode session.

### MCP Configuration
Add this to your \`.mcp.json\`:
\`\`\`json
{
  "mcpServers": {
    "docrelay": {
      "command": "npx",
      "args": ["docrelay"]
    }
  }
}
\`\`\`

### CLI Quick Reference
\`\`\`
docrelay status              # Health dashboard
docrelay check               # Find stale docs
docrelay check --strict      # Exit 1 if any stale docs
docrelay impact src/foo.ts   # What docs are affected?
docrelay sync --symbol <id>  # Sync docs for a symbol
docrelay scan                # Rescan codebase
\`\`\`
`;

// ── Oh My Pi section ─────────────────────────────────────────────────
const PI_DOCRELAY_SECTION = `# DocRelay — Code-Documentation Sync

DocRelay keeps your code symbols and documentation in sync.

## Shell Alias (recommended)
Add this to your shell profile (~/.zshrc or ~/.bashrc):

\`\`\`sh
alias docrelay='npx docrelay'
\`\`\`

## Commands
| Command | Purpose |
|---------|---------|
| \`docrelay status\` | Health dashboard |
| \`docrelay check\` | Find stale docs |
| \`docrelay check --strict\` | Exit 1 if any stale |
| \`docrelay impact <file>\` | Docs affected by change |
| \`docrelay sync --symbol <id>\` | Sync docs for symbol |
| \`docrelay scan\` | Rescan codebase |
`;

// ── Generic instructions (unknown agent) ─────────────────────────────
const GENERIC_INSTRUCTIONS = `# DocRelay Agent Integration

DocRelay is a code-documentation relational sync system. It tracks symbols
(function, classes, etc.) and their linked documentation, keeping them in
sync as the codebase changes.

## Setup

### 1. MCP Server (if your agent supports MCP)
Add this to your MCP configuration:
\`\`\`json
{
  "mcpServers": {
    "docrelay": {
      "command": "npx",
      "args": ["docrelay"]
    }
  }
}
\`\`\`

### 2. Shell Alias
\`\`\`sh
alias docrelay='npx docrelay'
\`\`\`

### 3. Recommended Workflow
- At session start, run \`docrelay status\` to see documentation health
- After code changes, run \`docrelay impact <file>\` to check affected docs
- Run \`docrelay check --strict\` before committing to catch stale docs

## Available Tools
| Tool | Purpose |
|------|---------|
| \`docrelay_status\` | Health dashboard |
| \`docrelay_check\` | Find stale docs |
| \`docrelay_impact\` | Docs affected by changed files |
| \`docrelay_sync\` | Sync docs for a symbol |
| \`docrelay_link\` | Map symbols to docs |
| \`docrelay_diff\` | Change history for a symbol |
| \`docrelay_scan\` | Rescan codebase |

## CLI Commands
\`\`\`
docrelay status              # Health dashboard
docrelay check               # Find stale docs
docrelay check --strict      # Exit 1 if stale (good for CI)
docrelay impact src/foo.ts   # Impact analysis
docrelay sync --symbol <id>  # Sync docs
docrelay scan                # Rescan
\`\`\`
`;

// ── Append helpers ───────────────────────────────────────────────────

const MAX_RULES_FILE_SIZE = 1_048_576; // 1 MB — rules files are typically < 10 KB

function readFileWithSizeLimit(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_RULES_FILE_SIZE) {
      console.warn(`DocRelay: ${filePath} exceeds ${MAX_RULES_FILE_SIZE} bytes — skipping integration`);
      return null;
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function appendToRulesFile(
  rulesPath: string,
  section: string,
  sectionMarker: string,
): boolean {
  // F22: Guard against empty sectionMarker — anyString.includes('') is
  // always true, causing silent idempotency bypass. Current callers pass
  // non-empty constants, but this provides defense-in-depth.
  if (!sectionMarker || sectionMarker.trim() === '') {
    throw new Error('sectionMarker must not be empty');
  }

  let existing = '';
  if (fs.existsSync(rulesPath)) {
    const content = readFileWithSizeLimit(rulesPath);
    if (content === null) return false;
    existing = content;
  }

  // Idempotent: skip if section marker is already present
  if (existing.includes(sectionMarker)) return false;

  const dir = path.dirname(rulesPath);
  fs.mkdirSync(dir, { recursive: true });

  // Ensure a trailing newline before appending
  const content = existing.endsWith('\n') ? existing + section : existing + '\n' + section;
  fs.writeFileSync(rulesPath, content, 'utf-8');
  return true;
}

function upsertMcpJson(projectRoot: string): boolean {
  const mcpPath = path.join(projectRoot, '.mcp.json');

  let mcpConfig: { mcpServers?: Record<string, unknown> };
  if (fs.existsSync(mcpPath)) {
    try {
      const stat = fs.statSync(mcpPath);
      if (stat.size > MAX_RULES_FILE_SIZE) {
        console.warn(`DocRelay: ${mcpPath} exceeds ${MAX_RULES_FILE_SIZE} bytes — skipping MCP integration`);
        return false;
      }
      const raw = fs.readFileSync(mcpPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // JSON.parse can return null for valid JSON input "null" — reject it.
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn(`DocRelay: ${mcpPath} does not contain a JSON object — skipping MCP integration`);
        return false;
      }
      mcpConfig = parsed as { mcpServers?: Record<string, unknown> };
    } catch (err: any) {
      // File exists but is not valid JSON — do NOT overwrite it with a
      // fresh config (that would destroy all other MCP server entries).
      console.warn(`DocRelay: cannot parse ${mcpPath}:`, err instanceof Error ? err.message : err);
      console.warn(`DocRelay: skipping MCP integration — fix or remove ${mcpPath} and re-run.`);
      return false;
    }
  } else {
    mcpConfig = {};
  }

  if (!mcpConfig.mcpServers) {
    mcpConfig.mcpServers = {};
  }

  if (mcpConfig.mcpServers.docrelay) return false; // already present

  mcpConfig.mcpServers.docrelay = DOCRELAY_MCP_ENTRY.docrelay;
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
  return true;
}

// ── Per-agent integration ────────────────────────────────────────────

function integrateClaudeCode(
  projectRoot: string,
  dryRun: boolean,
  agentKind: AgentKind = 'claude-code',
  rulesFileName: string = 'CLAUDE.md',
): IntegrationResult {
  const files: string[] = [];
  const CLAUDE_SECTION_MARKER = '## DocRelay — Code-Documentation Sync';

  // Prefer project-root rules file; fall back to .claude/<rulesFile>
  const rootRules = path.join(projectRoot, rulesFileName);
  const dotRules = path.join(projectRoot, '.claude', rulesFileName);
  const rulesPath = fs.existsSync(rootRules) ? rootRules : dotRules;

  if (!dryRun) {
    const added = appendToRulesFile(rulesPath, CLAUDE_DOCRELAY_SECTION, CLAUDE_SECTION_MARKER);
    if (added) files.push(rulesPath);

    const mcpAdded = upsertMcpJson(projectRoot);
    if (mcpAdded) files.push(path.join(projectRoot, '.mcp.json'));
  } else {
    // Dry-run: predict what would happen
    const existing = readFileWithSizeLimit(rulesPath);
    if (existing === null || !existing.includes(CLAUDE_SECTION_MARKER)) files.push(rulesPath);

    const mcpPath = path.join(projectRoot, '.mcp.json');
    let hasDocrel = false;
    const mcpContent = readFileWithSizeLimit(mcpPath);
    if (mcpContent !== null) {
      try {
        const m = JSON.parse(mcpContent);
        // Guard against JSON.parse returning null (valid JSON input "null").
        // Without this, accessing m.mcpServers on null throws TypeError,
        // which the catch treats as "missing" — but upsertMcpJson correctly
        // detects null and skips modification, causing a dry-run vs actual
        // behavior discrepancy.
        if (typeof m === 'object' && m !== null) {
          hasDocrel = !!(m.mcpServers?.docrelay);
        }
      } catch { /* missing or invalid */ }
    }
    if (!hasDocrel) files.push(mcpPath);
  }

  const agentName = agentKind === 'codex' ? 'Codex' : 'Claude Code';
  return {
    agent: agentKind,
    filesCreated: files,
    summary: files.length > 0
      ? `${agentName} integration added: ${files.map((f) => path.relative(projectRoot, f)).join(', ')}`
      : `${agentName} integration already configured.`,
  };
}

function integrateOpenCode(projectRoot: string, dryRun: boolean): IntegrationResult {
  const files: string[] = [];
  const SECTION_MARKER = '## DocRelay — Code-Documentation Sync';
  const rulesPath = path.join(projectRoot, 'OPENCODE.md');

  if (!dryRun) {
    const added = appendToRulesFile(rulesPath, OPENCODE_DOCRELAY_SECTION, SECTION_MARKER);
    if (added) files.push(rulesPath);

    const mcpAdded = upsertMcpJson(projectRoot);
    if (mcpAdded) files.push(path.join(projectRoot, '.mcp.json'));
  } else {
    const existing = readFileWithSizeLimit(rulesPath);
    if (existing === null || !existing.includes(SECTION_MARKER)) files.push(rulesPath);

    const mcpPath = path.join(projectRoot, '.mcp.json');
    let hasDocrel = false;
    const mcpContent = readFileWithSizeLimit(mcpPath);
    if (mcpContent !== null) {
      try {
        const m = JSON.parse(mcpContent);
        // Guard against JSON.parse returning null — same rationale as above.
        if (typeof m === 'object' && m !== null) {
          hasDocrel = !!(m.mcpServers?.docrelay);
        }
      } catch { /* missing or invalid */ }
    }
    if (!hasDocrel) files.push(mcpPath);
  }

  return {
    agent: 'opencode',
    filesCreated: files,
    summary: files.length > 0
      ? `OpenCode integration added: ${files.map((f) => path.relative(projectRoot, f)).join(', ')}`
      : 'OpenCode integration already configured.',
  };
}

function integrateOhMyPi(projectRoot: string, dryRun: boolean, agentKind: AgentKind = 'oh-my-pi'): IntegrationResult {
  const files: string[] = [];
  const SECTION_MARKER = '# DocRelay — Code-Documentation Sync';
  const rulesPath = path.join(projectRoot, '.pi', 'docrelay.md');

  if (!dryRun) {
    const added = appendToRulesFile(rulesPath, PI_DOCRELAY_SECTION, SECTION_MARKER);
    if (added) files.push(rulesPath);
  } else {
    const existing = readFileWithSizeLimit(rulesPath);
    if (existing === null || !existing.includes(SECTION_MARKER)) files.push(rulesPath);
  }

  const agentName = agentKind === 'hermes' ? 'Hermes' : 'Oh My Pi';
  return {
    agent: agentKind,
    filesCreated: files,
    summary: files.length > 0
      ? `${agentName} integration added: ${files.map((f) => path.relative(projectRoot, f)).join(', ')}`
      : `${agentName} integration already configured.`,
  };
}

function integrateGeneric(projectRoot: string, dryRun: boolean): IntegrationResult {
  const files: string[] = [];
  const outPath = path.join(projectRoot, '.docrelay', 'agent-instructions.md');

  if (!dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (!fs.existsSync(outPath)) {
      fs.writeFileSync(outPath, GENERIC_INSTRUCTIONS, 'utf-8');
      files.push(outPath);
    }
  } else {
    if (!fs.existsSync(outPath)) files.push(outPath);
  }

  return {
    agent: 'unknown',
    filesCreated: files,
    summary: files.length > 0
      ? `Generic agent instructions created: ${path.relative(projectRoot, outPath)}`
      : 'Generic agent instructions already exist.',
  };
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Generate agent-specific config files so DocRelay integrates with the user's
 * coding agent. Pass `agent` to force a specific kind, or omit it to
 * auto-detect. Pass `dryRun: true` to preview without writing files.
 */
export async function integrate(
  projectRoot: string,
  agent?: AgentKind,
  dryRun = false,
): Promise<IntegrationResult> {
  const kind = agent ?? 'unknown';
  const resolved = path.resolve(projectRoot);

  switch (kind) {
    case 'claude-code':
      return integrateClaudeCode(resolved, dryRun);
    case 'codex':
      return integrateClaudeCode(resolved, dryRun, 'codex', 'CODEX.md');
    case 'opencode':
      return integrateOpenCode(resolved, dryRun);
    case 'oh-my-pi':
      return integrateOhMyPi(resolved, dryRun);
    case 'hermes':
      return integrateOhMyPi(resolved, dryRun, 'hermes');
    default:
      return integrateGeneric(resolved, dryRun);
  }
}
