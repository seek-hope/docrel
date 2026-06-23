/**
 * Agent auto-detection via environment variables.
 *
 * Supported agents: claude-code, codex, opencode, oh-my-pi (pi family),
 * and hermes. Falls back to 'unknown' when no known session variable is set.
 */
export type AgentKind =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'oh-my-pi'
  | 'hermes'
  | 'unknown';

export interface AgentInfo {
  kind: AgentKind;
  name: string;
  mcpSupported: boolean;
  hooksSupported: boolean;
  rulesFile: string | null;
  sessionId: string | null;
}

const AGENT_REGISTRY: Array<{
  kind: AgentKind;
  name: string;
  envVars: string[];
  mcp: boolean;
  hooks: boolean;
  rulesFile: string | null;
}> = [
  {
    kind: 'claude-code',
    name: 'Claude Code',
    envVars: ['CLAUDE_CODE_SESSION_ID'],
    mcp: true,
    hooks: true,
    rulesFile: 'CLAUDE.md',
  },
  {
    kind: 'codex',
    name: 'Codex',
    envVars: ['CODEX_SESSION', 'CODEX_SESSION_ID'],
    mcp: true,
    hooks: true,
    rulesFile: 'CODEX.md',
  },
  {
    kind: 'opencode',
    name: 'OpenCode',
    envVars: ['OPENCODE_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: 'OPENCODE.md',
  },
  {
    kind: 'oh-my-pi',
    name: 'Oh My Pi',
    envVars: ['PI_SESSION', 'OH_MY_PI'],
    mcp: false,
    hooks: false,
    rulesFile: '.pi/docrel.md',
  },
  {
    kind: 'hermes',
    name: 'Hermes',
    envVars: ['HERMES_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: 'HERMES.md',
  },
];

const UNKNOWN_AGENT: AgentInfo = {
  kind: 'unknown',
  name: 'Unknown Agent',
  mcpSupported: false,
  hooksSupported: false,
  rulesFile: null,
  sessionId: null,
};

/**
 * Detect the current agent by inspecting well-known environment variables.
 * Returns the first match; order of checks is deterministic.
 */
export function detectAgent(): AgentInfo {
  for (const entry of AGENT_REGISTRY) {
    for (const envVar of entry.envVars) {
      const sessionId = process.env[envVar];
      if (sessionId) {
        return {
          kind: entry.kind,
          name: entry.name,
          mcpSupported: entry.mcp,
          hooksSupported: entry.hooks,
          rulesFile: entry.rulesFile,
          sessionId,
        };
      }
    }
  }

  return UNKNOWN_AGENT;
}
