import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectAgent } from '../../src/agents/detector.js';
import type { AgentKind } from '../../src/agents/detector.js';

describe('detectAgent', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear known agent env vars
    const vars = [
      'CLAUDE_CODE_SESSION_ID',
      'CODEX_SESSION',
      'CODEX_SESSION_ID',
      'OPENCODE_SESSION',
      'PI_SESSION',
      'OH_MY_PI',
      'HERMES_SESSION',
    ];
    for (const v of vars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    // Restore original env vars
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  });

  it('returns unknown when no agent env vars are set', () => {
    const result = detectAgent();
    expect(result.kind).toBe('unknown');
    expect(result.name).toBe('Unknown Agent');
    expect(result.mcpSupported).toBe(false);
    expect(result.hooksSupported).toBe(false);
    expect(result.sessionId).toBeNull();
  });

  it('detects claude-code via CLAUDE_CODE_SESSION_ID', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'abc123';
    const result = detectAgent();
    expect(result.kind).toBe('claude-code');
    expect(result.name).toBe('Claude Code');
    expect(result.mcpSupported).toBe(true);
    expect(result.hooksSupported).toBe(true);
    expect(result.rulesFile).toBe('CLAUDE.md');
    expect(result.sessionId).toBe('abc123');
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

  it('detects oh-my-pi via PI_SESSION', () => {
    process.env.PI_SESSION = 'pi-1';
    const result = detectAgent();
    expect(result.kind).toBe('oh-my-pi');
    expect(result.name).toBe('Oh My Pi');
    expect(result.mcpSupported).toBe(false);
    expect(result.hooksSupported).toBe(false);
    expect(result.rulesFile).toBe('.pi/docsync.md');
    expect(result.sessionId).toBe('pi-1');
  });

  it('detects oh-my-pi via OH_MY_PI', () => {
    process.env.OH_MY_PI = 'true';
    const result = detectAgent();
    expect(result.kind).toBe('oh-my-pi');
    expect(result.sessionId).toBe('true');
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

  it('returns first match when multiple env vars are set (claude-code wins)', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'claude-first';
    process.env.CODEX_SESSION = 'codex-second';
    process.env.OPENCODE_SESSION = 'oc-third';
    const result = detectAgent();
    // claude-code is checked first in the registry order
    expect(result.kind).toBe('claude-code');
    expect(result.sessionId).toBe('claude-first');
  });

  it('returns correct AgentKind type values', () => {
    const validKinds: AgentKind[] = [
      'claude-code', 'codex', 'opencode', 'oh-my-pi', 'hermes', 'unknown',
    ];
    // The result kind must be a valid AgentKind
    process.env.HERMES_SESSION = 'x';
    const result = detectAgent();
    expect(validKinds).toContain(result.kind);
  });
});
