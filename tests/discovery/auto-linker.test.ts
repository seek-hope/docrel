import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol, type SymbolRow } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { autoLink, type AutoLinkResult } from '../../src/discovery/auto-linker.js';
import type { ParsedDocSection } from '../../src/discovery/doc-parser.js';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';
import { listAllMappings } from '../../src/db/mappings.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('autoLink', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-autolink-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSymbol(name: string, kind: SymbolRow['kind'] = 'function', location: string = 'src/index.ts:42'): SymbolRow {
    const symId = symbolId('typescript', `${location}::${name}`, kind);
    return upsertSymbol(db, { id: symId, name, kind, location, signature: 'abc' });
  }

  /** Create a ParsedDocSection and also upsert it into the DB so FK constraints pass. */
  function makeDocSection(
    file: string,
    anchor: string,
    content: string,
    codeRefs: ParsedDocSection['codeRefs'] = [],
  ): ParsedDocSection {
    const section: ParsedDocSection = { file, anchor, content, codeRefs };
    const id = docSectionId(file, anchor);
    const hash = contentHash(content);
    upsertDocSection(db, { id, file, anchor, content_hash: hash, doc_type: 'standalone' });
    return section;
  }

  // ── Rule 1: Exact name match in heading (confidence 1.0) ──────────────────

  it('matches exact symbol name in heading (confidence 1.0)', () => {
    const sym = makeSymbol('login');
    const section = makeDocSection('docs/api.md', 'Login', 'Some content about login.');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(1);
    expect(result.highConfidence).toBe(1);

    const mappings = listAllMappings(db);
    expect(mappings).toHaveLength(1);
    expect(mappings[0].symbol_id).toBe(sym.id);
    expect(mappings[0].review_status).toBe('auto');
  });

  it('matches symbol name in heading with extra text (confidence 1.0)', () => {
    const sym = makeSymbol('login');
    const section = makeDocSection('docs/api.md', 'The login function', 'Content.');

    const result = autoLink(db, [sym], [section]);
    expect(result.highConfidence).toBe(1);
  });

  it('does not match unrelated heading', () => {
    const sym = makeSymbol('login');
    const section = makeDocSection('docs/api.md', 'Payment Processing', 'Content about payments.');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(0);
  });

  // ── Rule 2: Backtick match (confidence 0.9) ────────────────────────────────

  it('matches backtick code ref in section content (confidence 0.9)', () => {
    const sym = makeSymbol('login');
    const section = makeDocSection('docs/api.md', 'Overview', 'Calls the login system.', [
      { symbolName: 'login()', refType: 'backtick', confidence: 0.9, lineInDoc: 2 },
    ]);

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(1);
    expect(result.highConfidence).toBe(1);

    const mappings = listAllMappings(db);
    expect(mappings[0].review_status).toBe('auto');
  });

  it('matches backtick with method-style name', () => {
    const sym = makeSymbol('AuthService.login');
    const section = makeDocSection('docs/api.md', 'Auth', 'Use the auth service.', [
      { symbolName: 'AuthService.login(user)', refType: 'backtick', confidence: 0.9, lineInDoc: 2 },
    ]);

    const result = autoLink(db, [sym], [section]);
    expect(result.highConfidence).toBe(1);
  });

  // ── Rule 3: Code block match (confidence 0.7) ─────────────────────────────

  it('matches code block ref (confidence 0.7)', () => {
    const sym = makeSymbol('authenticate');
    const section = makeDocSection('docs/api.md', 'Example', 'Code example:', [
      { symbolName: 'authenticate(user)', refType: 'codeblock', confidence: 0.9, lineInDoc: 3 },
    ]);

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(1);
    expect(result.mediumConfidence).toBe(1); // 0.7 is medium (0.5–0.8)

    const mappings = listAllMappings(db);
    expect(mappings[0].review_status).toBe('auto');
  });

  // ── Rule 4: Fuzzy heading match (confidence 0.6) ──────────────────────────

  it('matches fuzzy heading — Authentication vs authenticate (confidence 0.6)', () => {
    const sym = makeSymbol('authenticate');
    const section = makeDocSection('docs/auth.md', 'Authentication', 'Auth docs.');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(1);
    expect(result.mediumConfidence).toBe(1);

    const mappings = listAllMappings(db);
    expect(mappings[0].review_status).toBe('auto');
  });

  it('matches fuzzy heading — Config vs configure (confidence 0.6)', () => {
    const sym = makeSymbol('configure');
    const section = makeDocSection('docs/setup.md', 'Configuration', 'Setup docs.');

    const result = autoLink(db, [sym], [section]);
    expect(result.mediumConfidence).toBe(1);
  });

  it('does not fuzzy match very different headings', () => {
    const sym = makeSymbol('login');
    const section = makeDocSection('docs/api.md', 'Payment Gateway Integration', 'Not related.');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(0);
  });

  // ── Rule 5: File-name convention (confidence 0.5) ─────────────────────────

  it('matches file-name convention — auth.md ↔ src/auth.ts (confidence 0.5)', () => {
    const sym = makeSymbol('doSomething', 'function', 'src/auth.ts:42');
    const section = makeDocSection('docs/auth.md', 'Overview', 'Auth docs.');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(1);
    expect(result.mediumConfidence).toBe(1);

    const mappings = listAllMappings(db);
    expect(mappings[0].review_status).toBe('auto');
  });

  it('matches file-name convention without extensions (confidence 0.5)', () => {
    const sym = makeSymbol('handler', 'function', 'src/api.ts:10');
    const section = makeDocSection('docs/api.md', 'Intro', 'API docs.');

    const result = autoLink(db, [sym], [section]);
    expect(result.mediumConfidence).toBe(1);
  });

  it('does not match file-name convention with different stems', () => {
    const sym = makeSymbol('foo', 'function', 'src/auth.ts:42');
    const section = makeDocSection('docs/payments.md', 'Overview', 'Not matching.');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(0);
  });

  // ── minConfidence ──────────────────────────────────────────────────────────

  it('respects minConfidence filter', () => {
    const sym = makeSymbol('doSomething', 'function', 'src/auth.ts:42');
    const section = makeDocSection('docs/auth.md', 'Overview', 'Auth docs.');

    // File-name match is 0.5, so minConfidence 0.6 should skip it
    const result = autoLink(db, [sym], [section], 0.6);
    expect(result.totalMatched).toBe(0);
  });

  it('default minConfidence 0.5 includes file-name matches', () => {
    const sym = makeSymbol('doSomething', 'function', 'src/auth.ts:42');
    const section = makeDocSection('docs/auth.md', 'Overview', 'Auth docs.');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(1);
  });

  it('with minConfidence 0.9 only gets exact and backtick matches', () => {
    const sym1 = makeSymbol('login', 'function', 'src/login.ts:10');
    const sym2 = makeSymbol('processPayment', 'function', 'src/payments.ts:10');

    const section = makeDocSection('docs/api.md', 'Login', 'Use `login()` to authenticate.', [
      { symbolName: 'login()', refType: 'backtick', confidence: 0.9, lineInDoc: 2 },
    ]);

    const result = autoLink(db, [sym1, sym2], [section], 0.9);
    // login matches via heading (1.0) and backtick (0.9) — counts once per symbol
    // processPayment has no match
    expect(result.totalMatched).toBe(1);
    expect(result.highConfidence).toBe(1);
  });

  // ── Duplicate handling ────────────────────────────────────────────────────

  it('skips already-existing mappings', () => {
    const sym = makeSymbol('login');
    const section = makeDocSection('docs/api.md', 'login', 'Login docs.');
    const docId = docSectionId(section.file, section.anchor);

    // Now that makeDocSection upserts the section, the FK constraint will pass
    db.prepare(
      'INSERT INTO mappings (symbol_id, doc_id, rel_type, review_status) VALUES (?, ?, ?, ?)'
    ).run(sym.id, docId, 'describes', 'auto');

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(0); // skipped because already exists

    const mappings = listAllMappings(db);
    expect(mappings).toHaveLength(1);
    expect(mappings[0].review_status).toBe('auto'); // original auto status preserved
  });

  // ── Priority: strongest match wins ────────────────────────────────────────

  it('returns highest confidence for a symbol when multiple rules apply', () => {
    const sym = makeSymbol('login', 'function', 'src/auth.ts:10');
    // This section triggers both heading match (1.0) and file-name match (0.5)
    const section = makeDocSection('docs/auth.md', 'login', 'Auth and login.', [
      { symbolName: 'login()', refType: 'backtick', confidence: 0.9, lineInDoc: 2 },
    ]);

    const result = autoLink(db, [sym], [section]);
    expect(result.totalMatched).toBe(1);
    expect(result.highConfidence).toBe(1);

    const mappings = listAllMappings(db);
    expect(mappings).toHaveLength(1);
    // The highest confidence should be recorded (heading match = 1.0)
    expect(mappings[0].review_status).toBe('auto');
  });

  // ── Multiple symbols and sections ─────────────────────────────────────────

  it('links multiple symbols across multiple sections', () => {
    const loginSym = makeSymbol('login');
    const authSym = makeSymbol('authenticate');
    const paySym = makeSymbol('processPayment');

    const authSection = makeDocSection('docs/auth.md', 'Login', 'Use `login()`.', [
      { symbolName: 'login()', refType: 'backtick', confidence: 0.9, lineInDoc: 2 },
    ]);
    const paySection = makeDocSection('docs/payments.md', 'Payment Processing', 'Processing.', [
      { symbolName: 'processPayment(order)', refType: 'codeblock', confidence: 0.9, lineInDoc: 3 },
    ]);

    const result = autoLink(db, [loginSym, authSym, paySym], [authSection, paySection]);
    expect(result.totalMatched).toBeGreaterThanOrEqual(2);
    expect(result.highConfidence).toBeGreaterThanOrEqual(1);
  });

  // ── Empty inputs ───────────────────────────────────────────────────────────

  it('returns zero results for empty symbols', () => {
    const section = makeDocSection('docs/api.md', 'login', 'Content.');
    const result = autoLink(db, [], [section]);
    expect(result.totalMatched).toBe(0);
  });

  it('returns zero results for empty sections', () => {
    const sym = makeSymbol('login');
    const result = autoLink(db, [sym], []);
    expect(result.totalMatched).toBe(0);
  });

  it('returns zero results for both empty', () => {
    const result = autoLink(db, [], []);
    expect(result.totalMatched).toBe(0);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('handles symbols with special characters in name', () => {
    const sym = makeSymbol('$special_fn');
    const section = makeDocSection('docs/api.md', '$special_fn', 'Special function.');

    const result = autoLink(db, [sym], [section]);
    expect(result.highConfidence).toBe(1);
  });

  it('handles very short symbol names', () => {
    const sym = makeSymbol('x');
    const section = makeDocSection('docs/api.md', 'x', 'Variable x.');

    const result = autoLink(db, [sym], [section]);
    expect(result.highConfidence).toBe(1);
  });

  it('throws for invalid minConfidence', () => {
    const sym = makeSymbol('login');
    const section = makeDocSection('docs/api.md', 'login', 'Content.');
    expect(() => autoLink(db, [sym], [section], -0.1)).toThrow();
    expect(() => autoLink(db, [sym], [section], 1.1)).toThrow();
  });

  it('heading ref codeRef triggers fuzzy match (confidence 0.6)', () => {
    const sym = makeSymbol('authenticate');
    const section = makeDocSection('docs/auth.md', 'Some Section', 'Content.', [
      { symbolName: 'authenticate()', refType: 'heading', confidence: 0.8, lineInDoc: 1 },
    ]);

    const result = autoLink(db, [sym], [section]);
    expect(result.mediumConfidence).toBe(1);
  });
});
