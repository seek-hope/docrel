import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { integrate } from '../../src/agents/integrate.js';

describe('integrate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-integrate-'));
    // Simulate a project root
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
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

    // .claude/CLAUDE.md should be created with the DocRelay section
    const claudePath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);
    const content = fs.readFileSync(claudePath, 'utf-8');
    expect(content).toContain('## DocRelay — Code-Documentation Sync');
    expect(content).toContain('doc-relay status');

    // .mcp.json should be created with docrelay entry
    const mcpPath = path.join(tmpDir, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(mcp.mcpServers.docrelay).toBeDefined();
    expect(mcp.mcpServers.docrelay.command).toBe('npx');
    // The generated entry must resolve to the PUBLISHED package and start the
    // MCP server — `npx docrelay` (no dash) is not a real npm package and
    // `npx doc-relay` alone launches the CLI, not the server.
    expect(mcp.mcpServers.docrelay.args).toEqual(['-y', 'doc-relay', 'mcp']);
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
    expect(content).toContain('## DocRelay — Code-Documentation Sync');
    // Original content should come before DocRelay section
    expect(content.indexOf('# My Project')).toBeLessThan(content.indexOf('## DocRelay'));
  });

  // ── opencode ─────────────────────────────────────────────────────

  it('creates OPENCODE.md and .mcp.json for opencode', async () => {
    const result = await integrate(tmpDir, 'opencode', false);
    expect(result.agent).toBe('opencode');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const opencodePath = path.join(tmpDir, 'OPENCODE.md');
    expect(fs.existsSync(opencodePath)).toBe(true);
    const content = fs.readFileSync(opencodePath, 'utf-8');
    expect(content).toContain('## DocRelay — Code-Documentation Sync');
  });

  // ── oh-my-pi ─────────────────────────────────────────────────────

  it('creates .pi/docrelay.md for oh-my-pi', async () => {
    const result = await integrate(tmpDir, 'oh-my-pi', false);
    expect(result.agent).toBe('oh-my-pi');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const piPath = path.join(tmpDir, '.pi', 'docrelay.md');
    expect(fs.existsSync(piPath)).toBe(true);
    const content = fs.readFileSync(piPath, 'utf-8');
    expect(content).toContain('# DocRelay — Code-Documentation Sync');
    expect(content).toContain('Shell Alias');
  });

  it('dry run for oh-my-pi reports without writing', async () => {
    const result = await integrate(tmpDir, 'oh-my-pi', true);
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, '.pi', 'docrelay.md'))).toBe(false);
  });

  // ── unknown ──────────────────────────────────────────────────────

  it('creates .docrelay/agent-instructions.md for unknown agent', async () => {
    const result = await integrate(tmpDir, 'unknown', false);
    expect(result.agent).toBe('unknown');
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);

    const genPath = path.join(tmpDir, '.docrelay', 'agent-instructions.md');
    expect(fs.existsSync(genPath)).toBe(true);
    const content = fs.readFileSync(genPath, 'utf-8');
    expect(content).toContain('DocRelay Agent Integration');
    expect(content).toContain('MCP Server');
  });

  // ── existing .mcp.json handling ──────────────────────────────────

  it('adds docrelay to existing .mcp.json without overwriting other servers', async () => {
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
    expect(mcp.mcpServers.docrelay).toBeDefined();
    expect(mcp.mcpServers.docrelay.command).toBe('npx');
  });

  it('does not duplicate docrelay in .mcp.json if already present', async () => {
    const existingMcp = {
      mcpServers: {
        docrelay: { command: 'npx', args: ['docrelay'] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(existingMcp, null, 2), 'utf-8');

    await integrate(tmpDir, 'claude-code', false);

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf-8'));
    // Should still have exactly one docrelay entry
    const keys = Object.keys(mcp.mcpServers);
    const docrelayEntries = keys.filter((k) => k === 'docrelay');
    expect(docrelayEntries.length).toBe(1);
  });

  // ── codex (uses claude-code integration) ─────────────────────────

  it('handles codex the same as claude-code', async () => {
    const result = await integrate(tmpDir, 'codex', false);
    expect(result.agent).toBe('codex'); // codex gets its own identity
    const codexPath = path.join(tmpDir, '.claude', 'CODEX.md');
    expect(fs.existsSync(codexPath)).toBe(true);
  });
});

describe('integrate — defensive paths & remaining agents', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-integ2-'));
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips an oversized rules file but still writes .mcp.json', async () => {
    const rulesPath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(rulesPath, '# Big\n', 'utf-8');
    fs.truncateSync(rulesPath, 2 * 1_048_576); // sparse 2 MB > 1 MB limit

    const result = await integrate(tmpDir, 'claude-code', false);
    expect(result.filesCreated.some((f) => f.endsWith('.mcp.json'))).toBe(true);
    expect(result.filesCreated.some((f) => f.endsWith('CLAUDE.md'))).toBe(false);
    // Original (huge) file untouched.
    expect(fs.statSync(rulesPath).size).toBe(2 * 1_048_576);
  });

  it('skips an oversized .mcp.json but still appends the rules section', async () => {
    const mcpPath = path.join(tmpDir, '.mcp.json');
    fs.writeFileSync(mcpPath, '{}\n', 'utf-8');
    fs.truncateSync(mcpPath, 2 * 1_048_576);

    const result = await integrate(tmpDir, 'claude-code', false);
    expect(result.filesCreated.some((f) => f.endsWith('CLAUDE.md'))).toBe(true);
    expect(result.filesCreated.some((f) => f.endsWith('.mcp.json'))).toBe(false);
  });

  it('skips a .mcp.json containing JSON null instead of an object', async () => {
    const mcpPath = path.join(tmpDir, '.mcp.json');
    fs.writeFileSync(mcpPath, 'null\n', 'utf-8');

    const result = await integrate(tmpDir, 'claude-code', false);
    expect(result.filesCreated.some((f) => f.endsWith('.mcp.json'))).toBe(false);
    expect(fs.readFileSync(mcpPath, 'utf-8')).toBe('null\n'); // preserved
    expect(result.filesCreated.some((f) => f.endsWith('CLAUDE.md'))).toBe(true);
  });

  it('skips an unparseable .mcp.json without destroying it', async () => {
    const mcpPath = path.join(tmpDir, '.mcp.json');
    fs.writeFileSync(mcpPath, '{ not json', 'utf-8');

    const result = await integrate(tmpDir, 'claude-code', false);
    expect(result.filesCreated.some((f) => f.endsWith('.mcp.json'))).toBe(false);
    expect(fs.readFileSync(mcpPath, 'utf-8')).toBe('{ not json');
  });

  it('creates only .mcp.json for cursor (no known rules file)', async () => {
    const result = await integrate(tmpDir, 'cursor', false);
    expect(result.filesCreated).toHaveLength(1);
    expect(result.filesCreated[0]).toContain('.mcp.json');
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers.docrelay).toBeTruthy();
  });

  it('creates .mcp.json and GEMINI.md for gemini', async () => {
    const result = await integrate(tmpDir, 'gemini', false);
    expect(result.filesCreated.some((f) => f.endsWith('.mcp.json'))).toBe(true);
    expect(result.filesCreated.some((f) => f.endsWith('GEMINI.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'GEMINI.md'), 'utf-8')).toContain('DocRelay');
  });

  it('is idempotent for gemini (second run reports already configured)', async () => {
    await integrate(tmpDir, 'gemini', false);
    const second = await integrate(tmpDir, 'gemini', false);
    expect(second.filesCreated).toHaveLength(0);
    expect(second.summary).toContain('already configured');
  });

  it('dry-run for kiro reports files without writing them', async () => {
    const result = await integrate(tmpDir, 'kiro', true);
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'KIRO.md'))).toBe(false);
  });

  it('dry-run for opencode reports without writing', async () => {
    const result = await integrate(tmpDir, 'opencode', true);
    expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, 'OPENCODE.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(false);
  });

  it('opencode second run reports already configured', async () => {
    await integrate(tmpDir, 'opencode', false);
    const second = await integrate(tmpDir, 'opencode', false);
    expect(second.filesCreated).toHaveLength(0);
    expect(second.summary).toContain('already configured');
  });

  it('creates .pi/docrelay.md for hermes with the Hermes agent label', async () => {
    const result = await integrate(tmpDir, 'hermes', false);
    expect(result.filesCreated.some((f) => f.includes('.pi'))).toBe(true);
    expect(result.summary).toContain('Hermes');
  });

  it('generic dry-run reports the instructions file only when missing', async () => {
    const first = await integrate(tmpDir, 'unknown', true);
    expect(first.filesCreated.some((f) => f.endsWith('agent-instructions.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.docrelay', 'agent-instructions.md'))).toBe(false);

    await integrate(tmpDir, 'unknown', false);
    const second = await integrate(tmpDir, 'unknown', true);
    expect(second.filesCreated).toHaveLength(0);
    expect(second.summary).toContain('already exist');
  });

  it('antigravity writes QAI.md', async () => {
    const result = await integrate(tmpDir, 'antigravity', false);
    expect(result.filesCreated.some((f) => f.endsWith('QAI.md'))).toBe(true);
  });
});
