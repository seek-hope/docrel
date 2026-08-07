/**
 * Agent auto-detection — two-layer approach inspired by CodeGraph's installer.
 *
 * Layer 1: well-known environment variables (identifies the CURRENTLY ACTIVE agent
 *           in this session — the one running doc-relay).
 * Layer 2: filesystem paths (identifies INSTALLED agents from config dirs/files).
 *           Fallback when no env var is set (e.g. doc-relay run outside a session).
 *
 * CodeGraph target ids are used for interoperability: {claude, cursor, codex,
 * opencode, hermes, gemini, antigravity, kiro}.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type AgentKind =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'oh-my-pi'
  | 'hermes'
  | 'cursor'
  | 'gemini'
  | 'antigravity'
  | 'kiro'
  | 'unknown';

export interface AgentInfo {
  kind: AgentKind;
  name: string;
  /** True when the agent supports MCP (Model Context Protocol). */
  mcpSupported: boolean;
  hooksSupported: boolean;
  /** Agent's primary instructions file. */
  rulesFile: string | null;
  /** Session id from env var, if detected. */
  sessionId: string | null;
  /** How the agent was detected: 'env' = active session, 'fs' = installed config. */
  detectionMethod: 'env' | 'fs' | 'none';
}

// ── Agent registry ────────────────────────────────────────────────────

interface AgentDef {
  kind: AgentKind;
  name: string;
  /** Env vars checked (first one set wins). First one is the canonical. */
  envVars: string[];
  mcp: boolean;
  hooks: boolean;
  rulesFile: string | null;
  /** Paths relative to $HOME that signal this agent is installed. */
  globalPaths: string[];
  /** Paths relative to $CWD that signal this agent is installed here. */
  localPaths: string[];
}

const HOME = os.homedir();

const AGENT_REGISTRY: AgentDef[] = [
  {
    kind: 'claude-code',
    name: 'Claude Code',
    envVars: ['CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CLAUDECODE'],
    mcp: true,
    hooks: true,
    rulesFile: 'CLAUDE.md',
    globalPaths: ['.claude', '.claude.json'],
    localPaths: ['.claude', '.mcp.json'],
  },
  {
    kind: 'codex',
    name: 'Codex',
    envVars: ['CODEX_SESSION', 'CODEX_SESSION_ID'],
    mcp: true,
    hooks: true,
    rulesFile: 'CODEX.md',
    globalPaths: ['.codex'],
    localPaths: ['.codex'],
  },
  {
    kind: 'cursor',
    name: 'Cursor',
    envVars: ['CURSOR_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: null,
    globalPaths: ['.cursor', 'Library/Application Support/Cursor'],
    localPaths: ['.cursor'],
  },
  {
    kind: 'opencode',
    name: 'OpenCode',
    envVars: ['OPENCODE_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: 'OPENCODE.md',
    globalPaths: ['.opencode'],
    localPaths: ['.opencode'],
  },
  {
    kind: 'hermes',
    name: 'Hermes',
    envVars: ['HERMES_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: 'HERMES.md',
    globalPaths: ['.hermes'],
    localPaths: ['.hermes'],
  },
  {
    kind: 'gemini',
    name: 'Gemini CLI',
    envVars: ['GEMINI_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: 'GEMINI.md',
    globalPaths: ['.gemini'],
    localPaths: ['.gemini'],
  },
  {
    kind: 'antigravity',
    name: 'Antigravity',
    envVars: ['ANTIGRAVITY_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: 'QAI.md',
    globalPaths: ['.antigravity'],
    localPaths: ['.antigravity'],
  },
  {
    kind: 'kiro',
    name: 'Kiro',
    envVars: ['KIRO_SESSION'],
    mcp: true,
    hooks: false,
    rulesFile: 'KIRO.md',
    globalPaths: ['.kiro'],
    localPaths: ['.kiro'],
  },
  {
    kind: 'oh-my-pi',
    name: 'Oh My Pi',
    envVars: ['PI_SESSION', 'OH_MY_PI'],
    mcp: false,
    hooks: false,
    rulesFile: '.pi/docrelay.md',
    globalPaths: ['.pi'],
    localPaths: ['.pi'],
  },
];

const UNKNOWN_AGENT: AgentInfo = {
  kind: 'unknown',
  name: 'Unknown Agent',
  mcpSupported: false,
  hooksSupported: false,
  rulesFile: null,
  sessionId: null,
  detectionMethod: 'none',
};

// ── Detection ─────────────────────────────────────────────────────────

/**
 * Layer 1: detect the agent running this process via env vars.
 * Returns the first agent whose env var is set, or null.
 */
function detectByEnv(): AgentDef | null {
  for (const entry of AGENT_REGISTRY) {
    for (const envVar of entry.envVars) {
      if (process.env[envVar]) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * Layer 2: detect installed agents by checking well-known filesystem paths.
 * Returns all agents that appear to be installed globally or locally.
 */
function detectByFilesystem(cwd: string): AgentDef[] {
  const found: AgentDef[] = [];
  for (const entry of AGENT_REGISTRY) {
    const globalMatch = entry.globalPaths.some((p) =>
      fs.existsSync(path.join(HOME, p)),
    );
    const localMatch = entry.localPaths.some((p) =>
      fs.existsSync(path.join(cwd, p)),
    );
    if (globalMatch || localMatch) found.push(entry);
  }
  return found;
}

/**
 * Detect all installed agents (Layer 2). Returns an array of AgentInfo
 * for every agent whose config directory exists on disk.
 */
export function detectInstalledAgents(cwd?: string): AgentInfo[] {
  const dir = cwd ?? process.cwd();
  return detectByFilesystem(dir).map((entry) => toAgentInfo(entry, 'fs'));
}

/**
 * Detect the current agent.
 *
 * Priority:
 * 1. Environment variables (active session — running agent)
 * 2. Filesystem (installed agents — pick the first one found)
 * 3. Unknown fallback
 */
export function detectAgent(): AgentInfo {
  // Layer 1: active session (env var)
  const envHit = detectByEnv();
  if (envHit) return toAgentInfo(envHit, 'env');

  // Layer 2: installed config (filesystem)
  const fsHits = detectByFilesystem(process.cwd());
  if (fsHits.length > 0) return toAgentInfo(fsHits[0], 'fs');

  return UNKNOWN_AGENT;
}

// ── Helpers ────────────────────────────────────────────────────────────

function toAgentInfo(
  entry: AgentDef,
  method: 'env' | 'fs',
): AgentInfo {
  const sessionId =
    method === 'env'
      ? entry.envVars.reduce<string | null>(
          (acc, v) => acc ?? process.env[v] ?? null,
          null,
        )
      : null;
  return {
    kind: entry.kind,
    name: entry.name,
    mcpSupported: entry.mcp,
    hooksSupported: entry.hooks,
    rulesFile: entry.rulesFile,
    sessionId,
    detectionMethod: method,
  };
}
