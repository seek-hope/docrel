import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectAgent, detectInstalledAgents } from '../../src/agents/detector.js';
import type { AgentKind } from '../../src/agents/detector.js';
import fs from 'node:fs';

describe('detectAgent', () => {
  const savedEnv: Record<string, string | undefined> = {};

  // All known env vars across all registered agents
  const ALL_ENV_VARS = [
    'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CLAUDECODE',
    'CODEX_SESSION', 'CODEX_SESSION_ID',
    'CURSOR_SESSION',
    'OPENCODE_SESSION',
    'HERMES_SESSION',
    'GEMINI_SESSION',
    'ANTIGRAVITY_SESSION',
    'KIRO_SESSION',
    'PI_SESSION', 'OH_MY_PI',
  ];

  beforeEach(() => {
    for (const v of ALL_ENV_VARS) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
    // Stub filesystem checks so Layer 2 doesn't interfere with Layer 1 tests
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
    vi.restoreAllMocks();
  });

  // ── Layer 1: env var detection ────────────────────────────────────

  it('returns unknown when no agent env vars are set and no agent is installed', () => {
    const result = detectAgent();
    expect(result.kind).toBe('unknown');
    expect(result.name).toBe('Unknown Agent');
    expect(result.mcpSupported).toBe(false);
    expect(result.hooksSupported).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.detectionMethod).toBe('none');
  });

  it('detects claude-code via CLAUDE_CODE_SESSION_ID (env)', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'abc123';
    const result = detectAgent();
    expect(result.kind).toBe('claude-code');
    expect(result.name).toBe('Claude Code');
    expect(result.mcpSupported).toBe(true);
    expect(result.hooksSupported).toBe(true);
    expect(result.rulesFile).toBe('CLAUDE.md');
    expect(result.sessionId).toBe('abc123');
    expect(result.detectionMethod).toBe('env');
  });

  it('detects claude-code via AI_AGENT', () => {
    process.env.AI_AGENT = 'claude-code_2-1-191_agent';
    const result = detectAgent();
    expect(result.kind).toBe('claude-code');
    expect(result.detectionMethod).toBe('env');
  });

  it('detects claude-code via CLAUDECODE', () => {
    process.env.CLAUDECODE = '1';
    const result = detectAgent();
    expect(result.kind).toBe('claude-code');
    expect(result.detectionMethod).toBe('env');
  });

  it('detects codex via CODEX_SESSION_ID', () => {
    process.env.CODEX_SESSION_ID = 'cx-456';
    const result = detectAgent();
    expect(result.kind).toBe('codex');
    expect(result.name).toBe('Codex');
    expect(result.mcpSupported).toBe(true);
    expect(result.sessionId).toBe('cx-456');
  });

  it('detects codex via CODEX_SESSION', () => {
    process.env.CODEX_SESSION = 'cx-789';
    const result = detectAgent();
    expect(result.kind).toBe('codex');
    expect(result.sessionId).toBe('cx-789');
  });

  it('detects opencode via OPENCODE_SESSION', () => {
    process.env.OPENCODE_SESSION = 'oc-sess';
    const result = detectAgent();
    expect(result.kind).toBe('opencode');
    expect(result.name).toBe('OpenCode');
    expect(result.mcpSupported).toBe(true);
    expect(result.hooksSupported).toBe(false);
    expect(result.rulesFile).toBe('OPENCODE.md');
    expect(result.sessionId).toBe('oc-sess');
  });

  it('detects hermes via HERMES_SESSION', () => {
    process.env.HERMES_SESSION = 'hm-42';
    const result = detectAgent();
    expect(result.kind).toBe('hermes');
    expect(result.name).toBe('Hermes');
    expect(result.mcpSupported).toBe(true);
    expect(result.hooksSupported).toBe(false);
    expect(result.rulesFile).toBe('HERMES.md');
    expect(result.sessionId).toBe('hm-42');
  });

  it('detects oh-my-pi via PI_SESSION', () => {
    process.env.PI_SESSION = 'pi-1';
    const result = detectAgent();
    expect(result.kind).toBe('oh-my-pi');
    expect(result.name).toBe('Oh My Pi');
    expect(result.mcpSupported).toBe(false);
    expect(result.hooksSupported).toBe(false);
    expect(result.rulesFile).toBe('.pi/docrelay.md');
    expect(result.sessionId).toBe('pi-1');
  });

  it('detects oh-my-pi via OH_MY_PI', () => {
    process.env.OH_MY_PI = 'true';
    const result = detectAgent();
    expect(result.kind).toBe('oh-my-pi');
    expect(result.sessionId).toBe('true');
  });

  it('detects cursor via CURSOR_SESSION', () => {
    process.env.CURSOR_SESSION = 'csr-1';
    const result = detectAgent();
    expect(result.kind).toBe('cursor');
    expect(result.name).toBe('Cursor');
    expect(result.mcpSupported).toBe(true);
  });

  it('detects gemini via GEMINI_SESSION', () => {
    process.env.GEMINI_SESSION = 'gm-1';
    const result = detectAgent();
    expect(result.kind).toBe('gemini');
    expect(result.name).toBe('Gemini CLI');
    expect(result.mcpSupported).toBe(true);
    expect(result.rulesFile).toBe('GEMINI.md');
  });

  it('detects antigravity via ANTIGRAVITY_SESSION', () => {
    process.env.ANTIGRAVITY_SESSION = 'ag-1';
    const result = detectAgent();
    expect(result.kind).toBe('antigravity');
    expect(result.name).toBe('Antigravity');
    expect(result.rulesFile).toBe('QAI.md');
  });

  it('detects kiro via KIRO_SESSION', () => {
    process.env.KIRO_SESSION = 'kr-1';
    const result = detectAgent();
    expect(result.kind).toBe('kiro');
    expect(result.name).toBe('Kiro');
    expect(result.rulesFile).toBe('KIRO.md');
  });

  it('returns first match when multiple env vars are set (claude-code wins)', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'claude-first';
    process.env.CODEX_SESSION = 'codex-second';
    process.env.OPENCODE_SESSION = 'oc-third';
    const result = detectAgent();
    expect(result.kind).toBe('claude-code');
    expect(result.sessionId).toBe('claude-first');
  });

  it('returns correct AgentKind type values', () => {
    const validKinds: AgentKind[] = [
      'claude-code', 'codex', 'cursor', 'opencode', 'oh-my-pi',
      'hermes', 'gemini', 'antigravity', 'kiro', 'unknown',
    ];
    process.env.HERMES_SESSION = 'x';
    const result = detectAgent();
    expect(validKinds).toContain(result.kind);
  });

  // ── Layer 2: filesystem detection ─────────────────────────────────

  it('falls back to filesystem when no env var is set', () => {
    vi.restoreAllMocks();
    // Simulate Claude Code installed on disk
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      return String(p).includes('.claude');
    });
    const result = detectAgent();
    expect(result.kind).toBe('claude-code');
    expect(result.detectionMethod).toBe('fs');
    expect(result.sessionId).toBeNull();
  });

  it('detectInstalledAgents returns all agents found on disk', () => {
    vi.restoreAllMocks();
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s.includes('.claude') || s.includes('.codex');
    });
    const installed = detectInstalledAgents('/fake/cwd');
    const kinds = installed.map((a) => a.kind);
    expect(kinds).toContain('claude-code');
    expect(kinds).toContain('codex');
    expect(installed.every((a) => a.detectionMethod === 'fs')).toBe(true);
  });
});
