/**
 * Covers the sync engine's write paths that the strategy-branch tests do not:
 * inline auto_update (happy path, codegraph-query signature source, file
 * mismatch repair, failure guards) and standalone auto_update (surgical
 * signature replacement, agent-pre-rewritten accounting, stale→in_sync mtime
 * transition).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OLD_SIG = 'export function login(user: string): boolean {';
const NEW_SIG = 'export function login(user: string, pass: string): boolean {';

// Function lands on line 4 (1-based) — symbol.location must point there.
const AUTH_TS = `/**
 * Authenticates a user.
 */
${OLD_SIG}
  return user.length > 0;
}
`;

function makeConfig(strategies: Partial<DocRelayConfig['strategies']> = {}): DocRelayConfig {
  return {
    version: 1,
    project: 'test',
    doc_dirs: ['docs'],
    code_dirs: ['src'],
    strategies: {
      inline: 'auto_update',
      standalone: 'auto_update',
      generated: 'mark_stale',
      architecture: 'mark_stale',
      ...strategies,
    },
  };
}

describe('syncSymbol — inline auto_update', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const sym = symbolId('typescript', 'src/auth.ts::login', 'function');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-engw-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), AUTH_TS, 'utf-8');
    db = getDb(tmpDir);
    runMigrations(db);
    // Post-scan state: DB raw_signature already holds the NEW signature while
    // the file on disk still has the OLD one.
    upsertSymbol(db, {
      id: sym, name: 'login', kind: 'function',
      location: 'src/auth.ts:4', raw_signature: NEW_SIG,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function linkInlineDoc(file = 'src/auth.ts'): string {
    const id = docSectionId(file, 'login');
    upsertDocSection(db, { id, file, anchor: 'login', doc_type: 'inline', status: 'stale' });
    createMapping(db, { symbol_id: sym, doc_id: id, rel_type: 'describes' });
    return id;
  }

  it('rewrites the signature in the source file and marks the doc synced', async () => {
    const docId = linkInlineDoc();

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toContain('src/auth.ts');
    const content = fs.readFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'utf-8');
    expect(content).toContain('pass: string');
    expect(content).toContain('/**'); // docstring regenerated, not destroyed
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
  });

  it('uses a fresh codegraph query for the current signature when available', async () => {
    const docId = linkInlineDoc();
    const getSymbolSignature = vi.fn(async () => OLD_SIG);
    const cg = { getSymbolSignature } as unknown as CodegraphClient;

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir, cg);

    expect(getSymbolSignature).toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toContain('src/auth.ts');
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
  });

  it('repairs a doc/file mismatch and proceeds against the symbol location', async () => {
    const docId = linkInlineDoc('src/old-location.ts');

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.warnings.some((w) => w.includes('repaired file mismatch'))).toBe(true);
    expect(getDocSection(db, docId)!.file).toBe('src/auth.ts');
    expect(result.docsUpdated).toContain('src/auth.ts');
  });

  it('errors instead of guessing when the symbol has no source location', async () => {
    const noLoc = symbolId('typescript', 'src/x.ts::ghost', 'function');
    upsertSymbol(db, { id: noLoc, name: 'ghost', kind: 'function', location: '', raw_signature: 'x' });
    const docId = docSectionId('src/x.ts', 'ghost');
    upsertDocSection(db, { id: docId, file: 'src/x.ts', anchor: 'ghost', doc_type: 'inline' });
    createMapping(db, { symbol_id: noLoc, doc_id: docId, rel_type: 'describes' });

    const result = await syncSymbol(db, makeConfig(), noLoc, tmpDir);

    expect(result.errors.some((e) => e.includes('invalid or missing source file location'))).toBe(true);
  });

  it('skips the sync when the existing docstring cannot be extracted (no data loss)', async () => {
    // File exists but does not contain the symbol → extractDocstring null.
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'export function other(): void {}\n', 'utf-8');
    const before = fs.readFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'utf-8');
    linkInlineDoc();

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.warnings.some((w) => w.includes('Could not extract existing docstring'))).toBe(true);
    expect(result.docsUpdated).toHaveLength(0);
    expect(fs.readFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'utf-8')).toBe(before);
  });

  it('refuses to generate docs when the symbol has no raw signature', async () => {
    // The docstring extraction must succeed first — the raw_signature guard
    // runs after it — so give the symbol its own file with a real docstring.
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'noraw.ts'),
      '/**\n * Existing docs.\n */\nexport function noraw(): void {}\n',
      'utf-8',
    );
    const noRaw = symbolId('typescript', 'src/noraw.ts::noraw', 'function');
    upsertSymbol(db, { id: noRaw, name: 'noraw', kind: 'function', location: 'src/noraw.ts:4' });
    const docId = docSectionId('src/noraw.ts', 'noraw');
    upsertDocSection(db, { id: docId, file: 'src/noraw.ts', anchor: 'noraw', doc_type: 'inline' });
    createMapping(db, { symbol_id: noRaw, doc_id: docId, rel_type: 'describes' });

    const result = await syncSymbol(db, makeConfig(), noRaw, tmpDir);

    expect(result.errors.some((e) => e.includes('no raw signature'))).toBe(true);
  });

  it('marks the inline doc stale under the mark_stale strategy without touching the file', async () => {
    const docId = linkInlineDoc();
    const before = fs.readFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'utf-8');

    const result = await syncSymbol(db, makeConfig({ inline: 'mark_stale' }), sym, tmpDir);

    expect(result.docsStaled).toContain('src/auth.ts');
    expect(getDocSection(db, docId)!.status).toBe('stale');
    expect(fs.readFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'utf-8')).toBe(before);
  });

  it('returns early when the symbol has no mappings', async () => {
    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toHaveLength(0);
    expect(result.docsStaled).toHaveLength(0);
  });
});

describe('syncSymbol — standalone auto_update write paths', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const sym = symbolId('typescript', 'src/auth.ts::login', 'function');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-engsa-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    // Source file already contains the NEW signature.
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), `${NEW_SIG}\n  return true;\n}\n`, 'utf-8');
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, {
      id: sym, name: 'login', kind: 'function',
      location: 'src/auth.ts:1', raw_signature: NEW_SIG,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function linkStandaloneDoc(): string {
    const id = docSectionId('docs/api.md', 'auth');
    upsertDocSection(db, { id, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone', status: 'stale' });
    createMapping(db, { symbol_id: sym, doc_id: id, rel_type: 'describes' });
    return id;
  }

  function recordOldSig(): void {
    db.prepare(
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig) VALUES (?, 'signature_changed', ?, ?)",
    ).run(sym, OLD_SIG, NEW_SIG);
  }

  it('surgically replaces the documented signature using the changelog old text', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'api.md'),
      `## auth\n\n\`export function login(user: string): boolean\`\n\nAuthenticates a user.\n`,
      'utf-8',
    );
    const docId = linkStandaloneDoc();
    recordOldSig();

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toContain('docs/api.md');
    const content = fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8');
    expect(content).toContain('pass: string');
    expect(content).not.toContain('login(user: string): boolean`');
    const doc = getDocSection(db, docId)!;
    expect(doc.status).toBe('in_sync');
    expect(doc.content_hash).not.toBe('');
  });

  it('records a sync when an agent already rewrote the section (hash accounting)', async () => {
    // Section already shows the NEW signature — old text is gone, so surgical
    // replacement finds nothing, but the hash differs from the DB record.
    const sectionContent = '## auth\n\n`export function login(user: string, pass: string): boolean`\n\nUpdated by an agent.\n';
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), sectionContent, 'utf-8');
    const docId = linkStandaloneDoc();
    db.prepare("UPDATE doc_sections SET content_hash = 'stale-hash' WHERE id = ?").run(docId);
    recordOldSig();

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toContain('docs/api.md');
    const doc = getDocSection(db, docId)!;
    expect(doc.status).toBe('in_sync');
    expect(doc.content_hash).toBe(contentHash(sectionContent));
  });

  it('transitions stale → in_sync when content matches and the file was modified', async () => {
    const sectionContent = '## auth\n\nAlready accurate docs.\n';
    const docPath = path.join(tmpDir, 'docs', 'api.md');
    fs.writeFileSync(docPath, sectionContent, 'utf-8');
    const docId = linkStandaloneDoc();
    db.prepare('UPDATE doc_sections SET content_hash = ? WHERE id = ?').run(contentHash(sectionContent), docId);
    recordOldSig();
    // File mtime must be newer than doc.updated_at to prove a real rewrite.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(docPath, future, future);

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.docsChecked).toContain('docs/api.md');
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
  });

  it('stays stale when content matches but the file was never rewritten', async () => {
    const sectionContent = '## auth\n\nAlready accurate docs.\n';
    const docPath = path.join(tmpDir, 'docs', 'api.md');
    fs.writeFileSync(docPath, sectionContent, 'utf-8');
    const docId = linkStandaloneDoc();
    db.prepare('UPDATE doc_sections SET content_hash = ? WHERE id = ?').run(contentHash(sectionContent), docId);
    recordOldSig();
    // mtime far in the past — before doc.updated_at.
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(docPath, past, past);

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.docsChecked).toHaveLength(0);
    expect(getDocSection(db, docId)!.status).toBe('stale');
  });
});

describe('syncSymbol — misc engine branches', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const sym = symbolId('typescript', 'src/auth.ts::login', 'function');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-engmisc-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: sym, name: 'login', kind: 'function', location: 'src/auth.ts:1' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns and marks stale when no strategy is configured for a doc_type', async () => {
    const docId = docSectionId('docs/api.md', 'auth');
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone', status: 'in_sync' });
    createMapping(db, { symbol_id: sym, doc_id: docId, rel_type: 'describes' });
    const cfg = makeConfig();
    delete (cfg.strategies as Record<string, unknown>).standalone;

    const result = await syncSymbol(db, cfg, sym, tmpDir);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("No strategy configured for doc_type 'standalone'"));
    expect(result.docsStaled).toContain('docs/api.md');
  });

  it('renders DB-stored absolute in-project paths as relative in error messages', async () => {
    // A doc row with an absolute file (corrupt/legacy DB) — the error must
    // show the path relative to the project, not leak the absolute form.
    const docId = docSectionId('docs/gone.md', 'auth');
    upsertDocSection(db, {
      id: docId,
      file: path.join(tmpDir, 'docs', 'gone.md'),
      anchor: 'auth',
      doc_type: 'standalone',
    });
    createMapping(db, { symbol_id: sym, doc_id: docId, rel_type: 'describes' });

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.errors.some((e) => e.includes('docs/gone.md') && !e.includes(tmpDir))).toBe(true);
  });
});
