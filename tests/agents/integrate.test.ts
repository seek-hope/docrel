import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { integrate } from '../../src/agents/integrate.js';

describe('integrate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-integrate-'));
    // Simulate a project root
    fs.mkdirSync(path.join(tmpDir, '.docrel'), { recursive: true });
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

    // .claude/CLAUDE.md should be created with the DocRel section
    const claudePath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);
    const content = fs.readFileSync(claudePath, 'utf-8');
    expect(content).toContain('## DocRel — Code-Documentation Sync');
    expect(content).toContain('docrel status');

    // .mcp.json should be created with docrel entry
    const mcpPath = path.join(tmpDir, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(mcp.mcpServers.docrel).toBeDefined();
    expect(mcp.mcpServers.docrel.command).toBe('npx');
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
    expect(content).toContain('## DocRel — Code-Documentation Sync');
    // Original content should come before DocRel section
    expect(content.indexOf('# My Project')).toBeLessThan(content.indexOf('## DocRel'));
  });

  // ── opencode ─────────────────────────────────────────────────────

  it('creates OPENCODE.md and .mcp.json for opencode', async () => {
    const result = await integrate(tmpDir, 'opencode', false);
    expect(result.agent).toBe('opencode');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const opencodePath = path.join(tmpDir, 'OPENCODE.md');
    expect(fs.existsSync(opencodePath)).toBe(true);
    const content = fs.readFileSync(opencodePath, 'utf-8');
    expect(content).toContain('## DocRel — Code-Documentation Sync');
  });

  // ── oh-my-pi ─────────────────────────────────────────────────────

  it('creates .pi/docrel.md for oh-my-pi', async () => {
    const result = await integrate(tmpDir, 'oh-my-pi', false);
    expect(result.agent).toBe('oh-my-pi');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const piPath = path.join(tmpDir, '.pi', 'docrel.md');
    expect(fs.existsSync(piPath)).toBe(true);
    const content = fs.readFileSync(piPath, 'utf-8');
    expect(content).toContain('# DocRel — Code-Documentation Sync');
    expect(content).toContain('Shell Alias');
  });

  it('dry run for oh-my-pi reports without writing', async () => {
    const result = await integrate(tmpDir, 'oh-my-pi', true);
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, '.pi', 'docrel.md'))).toBe(false);
  });

  // ── unknown ──────────────────────────────────────────────────────

  it('creates .docrel/agent-instructions.md for unknown agent', async () => {
    const result = await integrate(tmpDir, 'unknown', false);
    expect(result.agent).toBe('unknown');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const genPath = path.join(tmpDir, '.docrel', 'agent-instructions.md');
    expect(fs.existsSync(genPath)).toBe(true);
    const content = fs.readFileSync(genPath, 'utf-8');
    expect(content).toContain('DocRel Agent Integration');
    expect(content).toContain('MCP Server');
  });

  // ── existing .mcp.json handling ──────────────────────────────────

  it('adds docrel to existing .mcp.json without overwriting other servers', async () => {
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
    expect(mcp.mcpServers.docrel).toBeDefined();
    expect(mcp.mcpServers.docrel.command).toBe('npx');
  });

  it('does not duplicate docrel in .mcp.json if already present', async () => {
    const existingMcp = {
      mcpServers: {
        docrel: { command: 'npx', args: ['docrel'] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(existingMcp, null, 2), 'utf-8');

    await integrate(tmpDir, 'claude-code', false);

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf-8'));
    // Should still have exactly one docrel entry
    const keys = Object.keys(mcp.mcpServers);
    const docrelEntries = keys.filter((k) => k === 'docrel');
    expect(docrelEntries.length).toBe(1);
  });

  // ── codex (uses claude-code integration) ─────────────────────────

  it('handles codex the same as claude-code', async () => {
    const result = await integrate(tmpDir, 'codex', false);
    expect(result.agent).toBe('codex'); // codex gets its own identity
    const codexPath = path.join(tmpDir, '.claude', 'CODEX.md');
    expect(fs.existsSync(codexPath)).toBe(true);
  });
});
