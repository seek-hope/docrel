import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { integrate } from '../../src/agents/integrate.js';

describe('integrate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsync-integrate-'));
    // Simulate a project root
    fs.mkdirSync(path.join(tmpDir, '.docsync'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── claude-code ──────────────────────────────────────────────────

  it('creates CLAUDE.md and .mcp.json for claude-code (dry run)', async () => {
    const result = await integrate(tmpDir, 'claude-code', true);
    expect(result.agent).toBe('claude-code');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
    // Nothing should be written
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('creates CLAUDE.md and .mcp.json for claude-code (real run)', async () => {
    const result = await integrate(tmpDir, 'claude-code', false);
    expect(result.agent).toBe('claude-code');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    // .claude/CLAUDE.md should be created with the DocSync section
    const claudePath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);
    const content = fs.readFileSync(claudePath, 'utf-8');
    expect(content).toContain('## DocSync — Code-Documentation Sync');
    expect(content).toContain('docsync status');

    // .mcp.json should be created with docsync entry
    const mcpPath = path.join(tmpDir, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(mcp.mcpServers.docsync).toBeDefined();
    expect(mcp.mcpServers.docsync.command).toBe('npx');
  });

  it('is idempotent for claude-code integration', async () => {
    // First integration
    await integrate(tmpDir, 'claude-code', false);
    // Second integration should not duplicate content
    const result2 = await integrate(tmpDir, 'claude-code', false);
    expect(result2.filesCreated.length).toBe(0);
    expect(result2.summary).toContain('already configured');
  });

  it('appends to existing CLAUDE.md without overwriting original content', async () => {
    const existingContent = '# My Project\n\nSome existing instructions.\n';
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), existingContent, 'utf-8');

    await integrate(tmpDir, 'claude-code', false);

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Some existing instructions.');
    expect(content).toContain('## DocSync — Code-Documentation Sync');
    // Original content should come before DocSync section
    expect(content.indexOf('# My Project')).toBeLessThan(content.indexOf('## DocSync'));
  });

  // ── opencode ─────────────────────────────────────────────────────

  it('creates OPENCODE.md and .mcp.json for opencode', async () => {
    const result = await integrate(tmpDir, 'opencode', false);
    expect(result.agent).toBe('opencode');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const opencodePath = path.join(tmpDir, 'OPENCODE.md');
    expect(fs.existsSync(opencodePath)).toBe(true);
    const content = fs.readFileSync(opencodePath, 'utf-8');
    expect(content).toContain('## DocSync — Code-Documentation Sync');
  });

  // ── oh-my-pi ─────────────────────────────────────────────────────

  it('creates .pi/docsync.md for oh-my-pi', async () => {
    const result = await integrate(tmpDir, 'oh-my-pi', false);
    expect(result.agent).toBe('oh-my-pi');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const piPath = path.join(tmpDir, '.pi', 'docsync.md');
    expect(fs.existsSync(piPath)).toBe(true);
    const content = fs.readFileSync(piPath, 'utf-8');
    expect(content).toContain('# DocSync — Code-Documentation Sync');
    expect(content).toContain('Shell Alias');
  });

  it('dry run for oh-my-pi reports without writing', async () => {
    const result = await integrate(tmpDir, 'oh-my-pi', true);
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, '.pi', 'docsync.md'))).toBe(false);
  });

  // ── unknown ──────────────────────────────────────────────────────

  it('creates .docsync/agent-instructions.md for unknown agent', async () => {
    const result = await integrate(tmpDir, 'unknown', false);
    expect(result.agent).toBe('unknown');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const genPath = path.join(tmpDir, '.docsync', 'agent-instructions.md');
    expect(fs.existsSync(genPath)).toBe(true);
    const content = fs.readFileSync(genPath, 'utf-8');
    expect(content).toContain('DocSync Agent Integration');
    expect(content).toContain('MCP Server');
  });

  // ── existing .mcp.json handling ──────────────────────────────────

  it('adds docsync to existing .mcp.json without overwriting other servers', async () => {
    const existingMcp = {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js'] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(existingMcp, null, 2), 'utf-8');

    await integrate(tmpDir, 'claude-code', false);

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers['my-server']).toBeDefined();
    expect(mcp.mcpServers['my-server'].command).toBe('node');
    expect(mcp.mcpServers.docsync).toBeDefined();
    expect(mcp.mcpServers.docsync.command).toBe('npx');
  });

  it('does not duplicate docsync in .mcp.json if already present', async () => {
    const existingMcp = {
      mcpServers: {
        docsync: { command: 'npx', args: ['docsync'] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(existingMcp, null, 2), 'utf-8');

    await integrate(tmpDir, 'claude-code', false);

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf-8'));
    // Should still have exactly one docsync entry
    const keys = Object.keys(mcp.mcpServers);
    const docsyncEntries = keys.filter((k) => k === 'docsync');
    expect(docsyncEntries.length).toBe(1);
  });

  // ── codex (uses claude-code integration) ─────────────────────────

  it('handles codex the same as claude-code', async () => {
    const result = await integrate(tmpDir, 'codex', false);
    expect(result.agent).toBe('codex'); // codex gets its own identity
    const codexPath = path.join(tmpDir, '.claude', 'CODEX.md');
    expect(fs.existsSync(codexPath)).toBe(true);
  });
});
