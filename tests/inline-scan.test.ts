// tests/inline-scan.test.ts
//
// Verifies the inline docstring collection path in the discovery scanner:
//  - JSDoc extraction wires an `inline` doc_section + mapping into the DB.
//  - Removing a docstring marks the inline section stale on rescan.
//  - A signature change marks the inline section stale (reuses the existing
//    markDocsStaleForSymbol closure).
//  - last_scan_at round-trips between legacy SQLite and ISO-8601 formats.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../src/db/connection.js';
import { runMigrations } from '../src/db/schema.js';
import { getDocSection } from '../src/db/docs.js';
import { getMappingsForSymbol } from '../src/db/mappings.js';
import { docSectionId, contentHash } from '../src/utils/hash.js';
import { scanProject } from '../src/discovery/scanner.js';
import { BuiltinExtractor, extractLeadingDocstring } from '../src/extractors/builtin.js';
import type { DocRelayConfig } from '../src/utils/config.js';
import type { DocSectionRow } from '../src/db/docs.js';

function makeConfig(projectRoot: string): DocRelayConfig {
  return {
    version: 1,
    project: path.basename(projectRoot),
    doc_dirs: [],
    code_dirs: ['src'],
    strategies: { inline: 'auto_update', standalone: 'auto_update', generated: 'auto_update', architecture: 'mark_stale' },
  } as DocRelayConfig;
}

function findSymbolId(db: ReturnType<typeof getDb>, report: Awaited<ReturnType<typeof scanProject>>, name: string): string {
  const id = report.scannedIds.find((sid) => {
    const row = db.prepare('SELECT name FROM symbols WHERE id = ?').get(sid) as { name: string } | undefined;
    return row?.name === name;
  });
  expect(id, `expected to find symbol '${name}'`).toBeTruthy();
  return id!;
}

describe('inline docstring collection', () => {
  let tmpDir: string;
  let srcDir: string;
  let db: ReturnType<typeof getDb>;
  let config: DocRelayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-inline-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    config = makeConfig(tmpDir);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('① JSDoc function produces an inline doc_section + mapping with correct content_hash', async () => {
    const file = path.join(srcDir, 'mod.ts');
    const docstring = [
      '/**',
      ' * Adds two numbers.',
      ' * @param a first number',
      ' * @param b second number',
      ' */',
    ].join('\n');
    fs.writeFileSync(file, [
      docstring,
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
      '',
      'function plain() {}',
    ].join('\n'));

    const report = await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    const symId = findSymbolId(db, report, 'add');

    // The inline anchor is keyed by file + name.
    const docId = docSectionId('src/mod.ts', 'inline:add');
    const doc = getDocSection(db, docId)!;
    expect(doc).toBeTruthy();
    expect(doc.doc_type).toBe('inline');
    expect(doc.file).toBe('src/mod.ts');
    expect(doc.anchor).toBe('inline:add');
    expect(doc.status).toBe('in_sync');
    expect(doc.content_hash).toBe(contentHash(docstring));

    // Symbol `plain` has no JSDoc → no inline doc.
    const plainSymId = findSymbolId(db, report, 'plain');
    expect(getMappingsForSymbol(db, plainSymId)).toHaveLength(0);

    // Mapping links the symbol to the inline doc.
    const mappings = getMappingsForSymbol(db, symId);
    expect(mappings).toHaveLength(1);
    expect(mappings[0].doc_id).toBe(docId);
    expect(mappings[0].rel_type).toBe('describes');
    expect(mappings[0].review_status).toBe('auto');

    // Rescanning is idempotent — no duplicate mappings appear.
    await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    expect(getMappingsForSymbol(db, symId)).toHaveLength(1);
  });

  it('② removing the JSDoc marks the inline section stale on rescan', async () => {
    const file = path.join(srcDir, 'mod.ts');
    fs.writeFileSync(file, [
      '/**',
      ' * Original docstring.',
      ' */',
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
    ].join('\n'));

    const report1 = await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    const symId = findSymbolId(db, report1, 'add');
    const docId = docSectionId('src/mod.ts', 'inline:add');
    expect(getDocSection(db, docId)!.status).toBe('in_sync');

    // Remove the JSDoc but keep the function.
    fs.writeFileSync(file, [
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
    ].join('\n'));

    await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    const doc: DocSectionRow = getDocSection(db, docId)!;
    expect(doc.status).toBe('stale');
    // mapping still references the (now stale) doc
    expect(getMappingsForSymbol(db, symId)).toHaveLength(1);
  });

  it('③ a signature change marks the inline doc stale (existing closure)', async () => {
    const file = path.join(srcDir, 'mod.ts');
    fs.writeFileSync(file, [
      '/**',
      ' * Adds numbers.',
      ' */',
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
    ].join('\n'));

    const report1 = await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    const symId = findSymbolId(db, report1, 'add');
    const docId = docSectionId('src/mod.ts', 'inline:add');
    expect(getDocSection(db, docId)!.status).toBe('in_sync');

    // Change the signature (parameter name differs) while keeping the docstring.
    fs.writeFileSync(file, [
      '/**',
      ' * Adds numbers.',
      ' */',
      'export function add(x: number, y: number) {',
      '  return x + y;',
      '}',
    ].join('\n'));

    await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    const doc: DocSectionRow = getDocSection(db, docId)!;
    // markSignatureChanged → markDocsStaleForSymbol stales the linked inline doc,
    // and upsert keeps it 'stale' (never auto-revives a previously stale doc).
    expect(doc.status).toBe('stale');

    const log = db.prepare('SELECT * FROM changelog WHERE symbol_id = ? AND change_type = ?').get(symId, 'signature_changed') as any;
    expect(log).toBeTruthy();
    const affected = JSON.parse(log.affected_docs);
    expect(affected).toContain(docId);
  });

  it('supports Python string-literal docstrings via the scan path', async () => {
    const file = path.join(srcDir, 'mod.py');
    fs.writeFileSync(file, [
      'def greet(name):',
      '    """Return a friendly greeting for the given name."""',
      '    return f"Hi {name}"',
      '',
      'def plain():',
      '    return 1',
    ].join('\n'));

    const report = await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    const greetSymId = findSymbolId(db, report, 'greet');
    const doc = getDocSection(db, docSectionId('src/mod.py', 'inline:greet'));
    expect(doc).toBeTruthy();
    expect(doc!.doc_type).toBe('inline');
    expect(doc!.content_hash).toBe(contentHash('"""Return a friendly greeting for the given name."""'));
    expect(getMappingsForSymbol(db, greetSymId)).toHaveLength(1);

    // plain() has no docstring → no inline doc section.
    const plainSymId = findSymbolId(db, report, 'plain');
    expect(getMappingsForSymbol(db, plainSymId)).toHaveLength(0);
  });

  it('skips single-line comments and license headers when extracting docstrings', () => {
    const lines = [
      '// Copyright 2024',
      '/* SPDX license header */',
      '/**',
      ' * Real docstring.',
      ' */',
      'export function foo() {}',
    ];
    expect(extractLeadingDocstring(lines, 5, 'typescript')).toBe('/**\n * Real docstring.\n */');

    // docstring separated from the definition by more than one blank line is not
    // attached.
    const far = ['/**', ' * Too far away.', ' */', '', '', 'export function bar() {}'];
    expect(extractLeadingDocstring(far, 5, 'typescript')).toBeUndefined();
  });

  it('④ last_scan_at round-trips between legacy SQLite and ISO formats', async () => {
    const file = path.join(srcDir, 'mod.ts');
    fs.writeFileSync(file, [
      '/**',
      ' * Adds numbers.',
      ' */',
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
    ].join('\n'));

    // Full scan writes an ISO-8601 last_scan_at.
    let report = await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);
    const stored = db.prepare("SELECT value FROM metadata WHERE key = 'last_scan_at'").get() as { value: string } | undefined;
    expect(stored?.value).toBeTruthy();
    expect(stored!.value).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    const parsed = new Date(stored!.value).getTime();
    expect(Number.isNaN(parsed)).toBe(false);

    // Simulate a value written by an older version (UTC datetime('now')).
    db.prepare("UPDATE metadata SET value = datetime('now') WHERE key = 'last_scan_at'").run();

    // Touch a new file so the incremental scan has something to pick up, and
    // force its mtime to predate "now" beyond the 1s tolerance by setting the
    // last_scan_at into the past first.
    db.prepare("UPDATE metadata SET value = '1970-01-01 00:00:00' WHERE key = 'last_scan_at'").run();
    const file2 = path.join(srcDir, 'mod2.ts');
    fs.writeFileSync(file2, [
      '/**',
      ' * Second function.',
      ' */',
      'export function second(a: number) {',
      '  return a;',
      '}',
    ].join('\n'));

    // Incremental scan must parse the (legacy) value and collect the new inline doc.
    report = await scanProject(new BuiltinExtractor(), db, config, tmpDir, false);
    expect(report.scannedIds.length).toBeGreaterThan(0);
    const secondSymId = findSymbolId(db, report, 'second');
    const secondDoc = getDocSection(db, docSectionId('src/mod2.ts', 'inline:second'));
    expect(secondDoc).toBeTruthy();
    expect(secondDoc!.doc_type).toBe('inline');

    // The scan rewrote last_scan_at back to ISO-8601 (round-trip completed).
    const rewritten = db.prepare("SELECT value FROM metadata WHERE key = 'last_scan_at'").get() as { value: string } | undefined;
    expect(rewritten!.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(new Date(rewritten!.value).getTime())).toBe(false);
  });
});
