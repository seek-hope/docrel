import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodegraphClient } from '../../src/codegraph/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ── helpers ─────────────────────────────────────────────────── */

const EXPLORE_SAMPLE = `**Exploration: symbols in src/**

Found 1 symbols across 1 files.

**Source Code**

**\`src/auth.ts\`** — login(function)

\`\`\`typescript
9\texport function login(user: string): boolean {
\`\`\`
`;

interface FakeMcp { callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

function connectedClient(handler: (name: string, args: Record<string, unknown>) => unknown): { cg: CodegraphClient; fake: FakeMcp } {
  const cg = new CodegraphClient('definitely-not-used');
  const fake: FakeMcp = {
    callTool: vi.fn().mockImplementation((params: { name: string; arguments: Record<string, unknown> }) =>
      Promise.resolve(handler(params.name, params.arguments))),
    close: vi.fn().mockResolvedValue(undefined),
  };
  // Inject the connected client, bypassing the real MCP child process.
  (cg as unknown as { client: unknown }).client = fake;
  return { cg, fake };
}

const ok = { isError: false, content: [] };

/* ── tool calls over an injected MCP client ──────────────────── */

describe('CodegraphClient tool methods', () => {
  afterEach(() => vi.restoreAllMocks());

  it('explore sends the query and parses symbols', async () => {
    const { cg, fake } = connectedClient((name) =>
      name === 'codegraph_status' ? ok : { content: [{ type: 'text', text: EXPLORE_SAMPLE }] });

    const result = await cg.explore('symbols in src/', 20);

    expect(fake.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codegraph_explore', arguments: { query: 'symbols in src/', maxFiles: 20 } }),
    );
    expect(result.files).toContain('src/auth.ts');
    expect(result.symbols.find((s) => s.name === 'login')).toMatchObject({
      file: 'src/auth.ts', line: 9, kind: 'function',
    });
    await cg.close();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('impact parses affected symbols with relation types and defaults', async () => {
    const { cg, fake } = connectedClient((name) =>
      name === 'codegraph_status' ? ok : {
        content: [{ type: 'text', text: 'foo (function) [calls] in src/a.ts:3\nbar (class) in src/b.ts:9' }],
      });

    const result = await cg.impact('login', 3);

    expect(fake.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codegraph_impact', arguments: { symbol: 'login', depth: 3 } }),
    );
    expect(result.affected).toEqual([
      { name: 'foo', kind: 'function', file: 'src/a.ts', relation: 'calls' },
      { name: 'bar', kind: 'class', file: 'src/b.ts', relation: 'depends_on' },
    ]);
  });

  it('search parses items and omits kind when not given', async () => {
    const { cg, fake } = connectedClient((name) =>
      name === 'codegraph_status' ? ok : {
        content: [{ type: 'text', text: 'baz (function) in src/c.ts:12' }],
      });

    const result = await cg.search('baz');
    expect(fake.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codegraph_search', arguments: { query: 'baz' } }),
    );
    expect(result.items).toEqual([{ name: 'baz', kind: 'function', file: 'src/c.ts', line: 12 }]);

    await cg.search('baz', 'function');
    expect(fake.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codegraph_search', arguments: { query: 'baz', kind: 'function' } }),
    );
  });

  it('getSymbolSignature extracts the definition line and strips line-number prefixes', async () => {
    const sample = 'context line\n123| export const computeThing = (x: number) => {\nother line';
    const { cg } = connectedClient((name) =>
      name === 'codegraph_status' ? ok : { content: [{ type: 'text', text: sample }] });

    const sig = await cg.getSymbolSignature('computeThing', 'src/math.ts');
    expect(sig).toBe('export const computeThing = (x: number) => {');
  });

  it('getSymbolSignature strips tab-separated line-number prefixes (newer codegraph format)', async () => {
    // Dogfood finding: current codegraph builds emit `67\tcode` in explore
    // source blocks; the pipe-only strip left the prefix in place and every
    // downstream signature occurrence check failed.
    const sample = 'context\n67\tconst NON_SYMBOL_KINDS = "a,b";\nother';
    const { cg } = connectedClient((name) =>
      name === 'codegraph_status' ? ok : { content: [{ type: 'text', text: sample }] });

    const sig = await cg.getSymbolSignature('NON_SYMBOL_KINDS', 'src/extractors/codegraph.ts');
    expect(sig).toBe('const NON_SYMBOL_KINDS = "a,b";');
  });

  it('getSymbolSignature returns null when no definition is present', async () => {
    const { cg } = connectedClient((name) =>
      name === 'codegraph_status' ? ok : { content: [{ type: 'text', text: 'nothing relevant here' }] });

    expect(await cg.getSymbolSignature('ghost')).toBeNull();
  });

  it('handles non-array content gracefully', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cg } = connectedClient((name) =>
      name === 'codegraph_status' ? ok : { content: 'not-an-array' });

    const result = await cg.explore('x');
    expect(result.symbols).toEqual([]);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('non-array content'))).toBe(true);
  });

  it('discards a dead client after two liveness failures and fails the call', async () => {
    const cg = new CodegraphClient('definitely-not-used-command');
    const fake: FakeMcp = {
      callTool: vi.fn().mockRejectedValue(new Error('process gone')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    (cg as unknown as { client: unknown }).client = fake;

    await expect(cg.explore('x')).rejects.toThrow();
    // Two liveness attempts, then the dead client is closed and discarded.
    expect(fake.callTool).toHaveBeenCalledTimes(2);
    expect(fake.close).toHaveBeenCalledTimes(1);
  }, 20000);
});

/* ── preflight against fake codegraph binaries ───────────────── */

describe('CodegraphClient.preflight', () => {
  let tmpDir: string;
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cgpre-'));
    // .npm/ in the path satisfies the allowed-prefix validation.
    binDir = path.join(tmpDir, '.npm', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeCodegraph(script: string, name = 'codegraph'): string {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, script, { mode: 0o755 });
    return p;
  }

  it('rejects commands with shell metacharacters', async () => {
    const cg = new CodegraphClient('codegraph; rm -rf /');
    expect(await cg.preflight()).toContain('unsafe characters');
  });

  it('rejects relative paths', async () => {
    const cg = new CodegraphClient('./codegraph');
    expect(await cg.preflight()).toContain('relative paths are not allowed');
  });

  it('reports when the binary is not on PATH', async () => {
    const cg = new CodegraphClient('codegraph-definitely-missing');
    expect(await cg.preflight()).toContain('not found on PATH');
  });

  it('reports when --version fails', async () => {
    fakeCodegraph('#!/bin/sh\nexit 1\n');
    const cg = new CodegraphClient('codegraph');
    expect(await cg.preflight()).toContain('failed to run');
  });

  it('reports when serve --help lacks --mcp', async () => {
    fakeCodegraph('#!/bin/sh\ncase "$1" in\n  --version) echo "codegraph 1.2.3" ;;\n  serve) echo "Usage: serve [--stdio]" ;;\nesac\n');
    const cg = new CodegraphClient('codegraph');
    const issue = await cg.preflight();
    expect(issue).toContain('1.2.3');
    expect(issue).toContain('does not show --mcp');
  });

  it('passes with a compliant binary and caches the result', async () => {
    fakeCodegraph('#!/bin/sh\ncase "$1" in\n  --version) echo "codegraph 1.2.3" ;;\n  serve) echo "Usage: serve [--mcp] [--watch]" ;;\nesac\n');
    const cg = new CodegraphClient('codegraph');
    expect(await cg.preflight()).toBeNull();
    // Second call returns the memoized result without re-executing.
    expect(await cg.preflight()).toBeNull();
  });
});
