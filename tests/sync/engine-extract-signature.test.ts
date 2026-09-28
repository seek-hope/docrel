/**
 * Branch coverage for extractCurrentSignature (engine.ts's regex signature
 * extractor): method definitions, Allman braces, overload skipping,
 * multi-line params, generic constraints, block-comment decoys, and the
 * failure guards (oversize name, directory, huge file).
 *
 * Success cases go through inline auto_update (docstring must be extractable
 * first); failure cases go through standalone auto_update where the doc file
 * exists but the SYMBOL's file is the problem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const config: DocRelayConfig = {
  version: 1,
  project: 'test',
  doc_dirs: ['docs'],
  code_dirs: ['src'],
  strategies: { inline: 'auto_update', standalone: 'auto_update', generated: 'mark_stale', architecture: 'mark_stale' },
};

describe('extractCurrentSignature — success branches (via inline sync)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-exsig-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run one inline sync for a symbol whose file contains `content`, with the
   * symbol at line `line` (1-based). rawNewSig is the post-scan signature.
   * Asserts signature extraction succeeded (no extraction-failure error).
   */
  async function runInlineCase(content: string, name: string, line: number, rawNewSig: string) {
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), content, 'utf-8');
    const id = symbolId('typescript', `src/auth.ts::${name}`, 'function');
    upsertSymbol(db, { id, name, kind: 'function', location: `src/auth.ts:${line}`, raw_signature: rawNewSig });
    const docId = docSectionId('src/auth.ts', name);
    upsertDocSection(db, { id: docId, file: 'src/auth.ts', anchor: name, doc_type: 'inline', status: 'stale' });
    createMapping(db, { symbol_id: id, doc_id: docId, rel_type: 'describes' });

    const result = await syncSymbol(db, config, id, tmpDir);
    expect(
      result.errors.filter((e) => e.includes('could not extract current signature')),
      `signature extraction should succeed; errors: ${result.errors.join(' | ')}`,
    ).toHaveLength(0);
    return result;
  }

  it('extracts a class method definition (no keyword prefix)', async () => {
    const result = await runInlineCase(
      'class Auth {\n  /**\n   * Login docs.\n   */\n  login(user: string): boolean {\n    return true;\n  }\n}\n',
      'login', 5, 'login(user: string, pass: string): boolean {',
    );
    expect(result.docsUpdated).toContain('src/auth.ts');
  });

  it('extracts an Allman-style function (brace on the next line)', async () => {
    await runInlineCase(
      '/**\n * Docs.\n */\nexport function login(user: string): boolean\n{\n  return true;\n}\n',
      'login', 4, 'export function login(user: string, pass: string): boolean\n{',
    );
  });

  it('skips overload declarations ending with ; and finds the implementation', async () => {
    await runInlineCase(
      '/**\n * Docs.\n */\nexport function login(user: string): boolean;\nexport function login(user: string): boolean {\n  return true;\n}\n',
      'login', 4, 'export function login(user: string, pass: string): boolean {',
    );
  });

  it('assembles a multi-line parameter list', async () => {
    await runInlineCase(
      '/**\n * Docs.\n */\nexport function login(\n  user: string,\n): boolean {\n  return true;\n}\n',
      'login', 4, 'export function login(\n  user: string,\n  pass: string,\n): boolean {',
    );
  });

  it('finds the parameter list past generic constraints containing parens', async () => {
    await runInlineCase(
      '/**\n * Docs.\n */\nexport function login<T extends (x: number) => boolean>(fn: T): boolean {\n  return true;\n}\n',
      'login', 4, 'export function login<T extends (x: number) => boolean>(fn: T, extra: string): boolean {',
    );
  });

  it('assembles a multi-line const-arrow signature', async () => {
    await runInlineCase(
      '/**\n * Docs.\n */\nexport const login = (\n  user: string,\n): boolean => {\n  return true;\n};\n',
      'login', 4, 'export const login = (\n  user: string,\n  pass: string,\n): boolean => {',
    );
  });

  it('ignores a same-named definition inside a leading block comment', async () => {
    const result = await runInlineCase(
      '/*\n * function login(old: number): void {}\n */\n\n/**\n * Docs.\n */\nexport function login(user: string): boolean {\n  return true;\n}\n',
      'login', 7, 'export function login(user: string, pass: string): boolean {',
    );
    expect(result.docsUpdated).toContain('src/auth.ts');
    const content = fs.readFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'utf-8');
    expect(content).toContain('pass: string');
  });

  it('extracts an Allman-style class method', async () => {
    await runInlineCase(
      'class Auth {\n  /**\n   * Docs.\n   */\n  login(user: string): boolean\n  {\n    return true;\n  }\n}\n',
      'login', 5, 'login(user: string, pass: string): boolean\n  {',
    );
  });

  it('accumulates a return-type line between the parameter list and the brace', async () => {
    await runInlineCase(
      'class Auth {\n  /**\n   * Docs.\n   */\n  login(\n    user: string\n  )\n  : boolean {\n    return true;\n  }\n}\n',
      'login', 5, 'login(\n    user: string,\n    pass: string\n  )\n  : boolean {',
    );
  });

  it('skips a same-line block-comment decoy before the real method', async () => {
    await runInlineCase(
      'class Auth {\n  /**\n   * Docs.\n   */\n  /* login(x: number) {} */ login(user: string): boolean {\n    return true;\n  }\n}\n',
      'login', 5, 'login(user: string, pass: string): boolean {',
    );
  });

  it('falls back to regex with a debug log when the codegraph query throws', async () => {
    process.env.DOCRELAY_DEBUG = '1';
    try {
      const cg = {
        getSymbolSignature: vi.fn(async () => { throw new Error('codegraph down'); }),
      } as unknown as CodegraphClient;
      const result = await runInlineCaseWithClient(
        '/**\n * Docs.\n */\nexport function login(user: string): boolean {\n  return true;\n}\n',
        'login', 4, 'export function login(user: string, pass: string): boolean {', cg,
      );
      expect(result.docsUpdated).toContain('src/auth.ts');
      expect(console.debug).toHaveBeenCalledWith(
        expect.stringContaining('getSymbolSignature failed'), 'codegraph down',
      );
    } finally {
      delete process.env.DOCRELAY_DEBUG;
    }
  });

  async function runInlineCaseWithClient(content: string, name: string, line: number, rawNewSig: string, cg: CodegraphClient) {
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), content, 'utf-8');
    const id = symbolId('typescript', `src/auth.ts::${name}`, 'function');
    upsertSymbol(db, { id, name, kind: 'function', location: `src/auth.ts:${line}`, raw_signature: rawNewSig });
    const docId = docSectionId('src/auth.ts', name);
    upsertDocSection(db, { id: docId, file: 'src/auth.ts', anchor: name, doc_type: 'inline', status: 'stale' });
    createMapping(db, { symbol_id: id, doc_id: docId, rel_type: 'describes' });
    return syncSymbol(db, config, id, tmpDir, cg);
  }
});

describe('extractCurrentSignature — failure guards (via standalone sync)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-exfail-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '## auth\n\nDocs here.\n', 'utf-8');
    db = getDb(tmpDir);
    runMigrations(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Standalone doc exists; the symbol's file is unreadable in some way, so
   *  extraction fails and the generic manual-rewrite error surfaces. */
  async function runStandaloneCase(name: string, location: string) {
    const id = symbolId('typescript', `src/x.ts::${name}`, 'function');
    upsertSymbol(db, { id, name, kind: 'function', location });
    const docId = docSectionId('docs/api.md', 'auth');
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: id, doc_id: docId, rel_type: 'describes' });

    const result = await syncSymbol(db, config, id, tmpDir);
    expect(result.errors.some((e) => e.includes('Cannot determine old signature text'))).toBe(true);
    return result;
  }

  it('rejects a symbol name over 500 chars (corruption guard)', async () => {
    await runStandaloneCase('x'.repeat(501), 'src/auth.ts:1');
  });

  it('rejects a symbol location pointing at a directory', async () => {
    await runStandaloneCase('login', 'src:1');
  });

  it('rejects a source file over the 10 MB limit', async () => {
    const bigPath = path.join(tmpDir, 'src', 'big.ts');
    fs.writeFileSync(bigPath, 'export {}\n', 'utf-8');
    fs.truncateSync(bigPath, 11 * 1024 * 1024); // sparse
    await runStandaloneCase('login', 'src/big.ts:1');
  });

  it('returns the invalid-location reason when the location is empty', async () => {
    await runStandaloneCase('login', '');
  });
});
