import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import {
  docrelayReview,
  cleanupOrphans,
  formatReview,
  formatReviewDetailed,
} from '../../src/tools/review.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('docrelayReview', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-review-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports unlinked symbols, orphaned sections, and unreviewed mappings with correct summary counts', () => {
    const symLinked = symbolId('typescript', 'src/a.ts::Linked', 'class');
    const symOrphan = symbolId('typescript', 'src/b.ts::Unlinked', 'class');
    const docMapped = docSectionId('docs/mapped.md', 'Guide');
    const docOrphan = docSectionId('docs/orphan.md', 'Notes');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'mapped.md'), '## Guide\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'orphan.md'), '## Notes\n', 'utf-8');

    upsertSymbol(db, { id: symLinked, name: 'Linked', kind: 'class', location: 'src/a.ts:1' });
    upsertSymbol(db, { id: symOrphan, name: 'Unlinked', kind: 'class', location: 'src/b.ts:1' });
    upsertDocSection(db, { id: docMapped, file: 'docs/mapped.md', anchor: 'Guide', doc_type: 'standalone', status: 'in_sync' });
    upsertDocSection(db, { id: docOrphan, file: 'docs/orphan.md', anchor: 'Notes', doc_type: 'standalone', status: 'in_sync' });

    // Auto mapping → unreviewed. Confirmed mapping → reviewed (not reported).
    createMapping(db, { symbol_id: symLinked, doc_id: docMapped, rel_type: 'describes' });
    const symConfirmed = symbolId('typescript', 'src/c.ts::Confirmed', 'class');
    const docConfirmed = docSectionId('docs/confirmed.md', 'Api');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'confirmed.md'), '## Api\n', 'utf-8');
    upsertSymbol(db, { id: symConfirmed, name: 'Confirmed', kind: 'class', location: 'src/c.ts:1' });
    upsertDocSection(db, { id: docConfirmed, file: 'docs/confirmed.md', anchor: 'Api', doc_type: 'standalone', status: 'in_sync' });
    createMapping(db, { symbol_id: symConfirmed, doc_id: docConfirmed, rel_type: 'describes', review_status: 'confirmed' });

    const report = docrelayReview(db, tmpDir);

    expect(report.unlinkedSymbols.map((s) => s.name)).toEqual(['Unlinked']);
    expect(report.orphanedSections.map((o) => `${o.file}#${o.anchor}`)).toEqual(['docs/orphan.md#Notes']);
    expect(report.unreviewedMappings).toHaveLength(1);
    expect(report.unreviewedMappings[0]).toMatchObject({
      symbolName: 'Linked',
      docFile: 'docs/mapped.md',
      docAnchor: 'Guide',
      reviewStatus: 'auto',
      relType: 'describes',
    });

    expect(report.summary).toEqual({
      totalSymbols: 3,
      linkedSymbols: 2,
      unlinkedCount: 1,
      orphanedCount: 1,
      impliedCount: 0,
      unreviewedCount: 1,
    });
  });

  it('detects implied references in doc text and skips already-mapped mentions', () => {
    const symMentioned = symbolId('typescript', 'src/svc.ts::FooService', 'class');
    const symMapped = symbolId('typescript', 'src/svc.ts::BarService', 'class');
    const docId = docSectionId('docs/guide.md', 'Guide');
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'guide.md'),
      '# Top\n\n## Guide\n\nThis describes FooService behavior and references BarService too.\n',
      'utf-8',
    );

    upsertSymbol(db, { id: symMentioned, name: 'FooService', kind: 'class', location: 'src/svc.ts:1' });
    upsertSymbol(db, { id: symMapped, name: 'BarService', kind: 'class', location: 'src/svc.ts:9' });
    upsertDocSection(db, { id: docId, file: 'docs/guide.md', anchor: 'Guide', doc_type: 'standalone', status: 'in_sync' });
    // BarService is already mapped to this section → must not be implied.
    createMapping(db, { symbol_id: symMapped, doc_id: docId, rel_type: 'describes', review_status: 'confirmed' });

    const report = docrelayReview(db, tmpDir);

    expect(report.impliedReferences).toHaveLength(1);
    expect(report.impliedReferences[0]).toMatchObject({
      symbolName: 'FooService',
      docFile: 'docs/guide.md',
      docAnchor: 'Guide',
      mentionLine: 2,
    });
    expect(report.impliedReferences[0].mentionText).toContain('FooService');
    expect(report.summary.impliedCount).toBe(1);
  });

  it('records skippedFiles for traversal paths and unreadable files', () => {
    // Absolute path escaping projectRoot (tampered DB row).
    upsertDocSection(db, {
      id: docSectionId('/etc/evil.md', 'Evil'),
      file: '/etc/evil.md',
      anchor: 'Evil',
      doc_type: 'standalone',
      status: 'in_sync',
    });
    // Relative traversal escaping projectRoot.
    upsertDocSection(db, {
      id: docSectionId('docs/../../etc/passwd.md', 'Trav'),
      file: 'docs/../../etc/passwd.md',
      anchor: 'Trav',
      doc_type: 'standalone',
      status: 'in_sync',
    });
    // Contained path but missing on disk → ENOENT skip.
    upsertDocSection(db, {
      id: docSectionId('docs/gone.md', 'Gone'),
      file: 'docs/gone.md',
      anchor: 'Gone',
      doc_type: 'standalone',
      status: 'in_sync',
    });

    const report = docrelayReview(db, tmpDir);
    const skipped = report.skippedFiles.join('\n');

    expect(skipped).toContain('/etc/evil.md (PATH_TRAVERSAL)');
    expect(skipped).toContain('docs/../../etc/passwd.md (PATH_TRAVERSAL)');
    expect(skipped).toContain('docs/gone.md (ENOENT)');
  });

  it('returns an empty report when the database connection is closed', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    closeDb(tmpDir);

    const report = docrelayReview(db, tmpDir);

    expect(report.summary.totalSymbols).toBe(0);
    expect(report.unlinkedSymbols).toEqual([]);
    expect(report.impliedReferences).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('skips doc entries whose file is a directory', () => {
    upsertSymbol(db, { id: symbolId('typescript', 'src/a.ts::Widget', 'class'), name: 'Widget', kind: 'class', location: 'src/a.ts:1' });
    upsertDocSection(db, { id: docSectionId('docs', 'Guide'), file: 'docs', anchor: 'Guide', doc_type: 'standalone', status: 'in_sync' });

    const report = docrelayReview(db, tmpDir);

    // A directory is neither readable text nor an error — skipped silently.
    expect(report.impliedReferences).toHaveLength(0);
    expect(report.skippedFiles).toHaveLength(0);
  });

  it('skips doc files larger than 1 MB during the implied scan', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'big.md'),
      '## Big\n\n' + 'filler '.repeat(200 * 1024) + 'Widget\n',
      'utf-8',
    );
    upsertSymbol(db, { id: symbolId('typescript', 'src/a.ts::Widget', 'class'), name: 'Widget', kind: 'class', location: 'src/a.ts:1' });
    upsertDocSection(db, { id: docSectionId('docs/big.md', 'Big'), file: 'docs/big.md', anchor: 'Big', doc_type: 'standalone', status: 'in_sync' });

    const report = docrelayReview(db, tmpDir);

    expect(report.impliedReferences).toHaveLength(0);
    expect(report.skippedFiles).toHaveLength(0);
  });

  it('skips sections whose anchor heading is missing from the file', () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '## Other\n\nWidget docs.\n', 'utf-8');
    upsertSymbol(db, { id: symbolId('typescript', 'src/a.ts::Widget', 'class'), name: 'Widget', kind: 'class', location: 'src/a.ts:1' });
    upsertDocSection(db, { id: docSectionId('docs/guide.md', 'Missing'), file: 'docs/guide.md', anchor: 'Missing', doc_type: 'standalone', status: 'in_sync' });

    const report = docrelayReview(db, tmpDir);

    expect(report.impliedReferences).toHaveLength(0);
  });

  it('skips sections with more than 100k lines', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'huge.md'),
      '## Huge\n\n' + 'line\n'.repeat(100_001) + 'Widget\n',
      'utf-8',
    );
    upsertSymbol(db, { id: symbolId('typescript', 'src/a.ts::Widget', 'class'), name: 'Widget', kind: 'class', location: 'src/a.ts:1' });
    upsertDocSection(db, { id: docSectionId('docs/huge.md', 'Huge'), file: 'docs/huge.md', anchor: 'Huge', doc_type: 'standalone', status: 'in_sync' });

    const report = docrelayReview(db, tmpDir);

    expect(report.impliedReferences).toHaveLength(0);
  });

  it('ignores symbol names shorter than two characters', () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '## Guide\n\nX and RealWidget appear here.\n', 'utf-8');
    upsertSymbol(db, { id: symbolId('typescript', 'src/a.ts::X', 'class'), name: 'X', kind: 'class', location: 'src/a.ts:1' });
    upsertSymbol(db, { id: symbolId('typescript', 'src/a.ts::RealWidget', 'class'), name: 'RealWidget', kind: 'class', location: 'src/a.ts:9' });
    upsertDocSection(db, { id: docSectionId('docs/guide.md', 'Guide'), file: 'docs/guide.md', anchor: 'Guide', doc_type: 'standalone', status: 'in_sync' });

    const report = docrelayReview(db, tmpDir);

    expect(report.impliedReferences.map((r) => r.symbolName)).toEqual(['RealWidget']);
  });
});

describe('cleanupOrphans — path safety', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cleanup-safety-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats DB-stored absolute paths escaping projectRoot as missing and removes them', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const evilDoc = docSectionId('/etc/evil.md', '');
    upsertDocSection(db, { id: evilDoc, file: '/etc/evil.md', anchor: '', doc_type: 'standalone', status: 'in_sync' });

    const result = cleanupOrphans(db, tmpDir);

    expect(result.orphanedSectionsRemoved).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM doc_sections WHERE id = ?').get(evilDoc)).toEqual({ c: 0 });
    logSpy.mockRestore();
  });
});

describe('formatReview / formatReviewDetailed', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-reviewfmt-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders an all-clear message for an empty report', () => {
    const out = formatReview(docrelayReview(db, tmpDir));
    expect(out).toContain('## DocRelay Review');
    expect(out).toContain('All clear');
  });

  it('groups same-name unlinked symbols with multiple locations into one line', () => {
    const report = docrelayReview(db, tmpDir);
    report.unlinkedSymbols.push(
      { id: 'a', name: 'Dup', kind: 'function', location: 'src/x.ts:1' },
      { id: 'b', name: 'Dup', kind: 'function', location: 'src/y.ts:2' },
      { id: 'c', name: 'Dup', kind: 'function', location: 'src/z.ts:3' },
      { id: 'd', name: 'Dup', kind: 'function', location: 'src/w.ts:4' },
    );
    report.summary.unlinkedCount = 4;

    const out = formatReview(report);
    const dupLines = out.split('\n').filter((l) => l.includes('`Dup`'));
    expect(dupLines).toHaveLength(1);
    expect(dupLines[0]).toContain('src/x.ts:1');
    expect(dupLines[0]).toContain('(+1 more)');
  });

  it('renders skipped files section', () => {
    const report = docrelayReview(db, tmpDir);
    report.skippedFiles.push('docs/gone.md (ENOENT)');
    const out = formatReview(report);
    expect(out).toContain('### Skipped Files (1)');
    expect(out).toContain('docs/gone.md (ENOENT)');
  });

  it('appends suggested actions naming the exact command for each issue category', () => {
    const report = docrelayReview(db, tmpDir);
    report.unlinkedSymbols.push({ id: 'a', name: 'Lonely', kind: 'function', location: 'src/x.ts:1' });
    report.impliedReferences.push({ symbolName: 'Mentioned', docFile: 'docs/a.md', docAnchor: 'A', mentionLine: 3, mentionText: '`Mentioned`' });
    report.unreviewedMappings.push({ symbolId: 'a', symbolName: 'Auto', docId: 'd', docFile: 'docs/a.md', docAnchor: 'A', reviewStatus: 'auto', relType: 'describes' });
    report.orphanedSections.push({ id: 'd', file: 'docs/a.md', anchor: 'A' });
    report.skippedFiles.push('docs/gone.md (ENOENT)');

    const out = formatReview(report);
    expect(out).toContain('### Suggested actions');
    expect(out).toContain('doc-relay scan');
    expect(out).toContain('doc-relay link create');
    expect(out).toContain('doc-relay confirm');
    expect(out).toContain('doc-relay review --cleanup');
    expect(out).toContain('doc_dirs');
    expect(out).not.toContain('All clear');
  });

  it('omits suggested actions when the report is all-clear', () => {
    const out = formatReview(docrelayReview(db, tmpDir));
    expect(out).toContain('All clear');
    expect(out).not.toContain('Suggested actions');
  });

  it('only suggests actions for categories that have issues', () => {
    const report = docrelayReview(db, tmpDir);
    report.unreviewedMappings.push({ symbolId: 'a', symbolName: 'Auto', docId: 'd', docFile: 'docs/a.md', docAnchor: 'A', reviewStatus: 'auto', relType: 'describes' });

    const out = formatReview(report);
    const actions = out.slice(out.indexOf('### Suggested actions'));
    expect(actions).toContain('doc-relay confirm');
    expect(actions).not.toContain('review --cleanup');
    expect(actions).not.toContain('doc-relay scan');
  });

  it('renders detailed review with source/doc snippets and confirm/reject hints', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'svc.ts'),
      'export class FooService {\n  run() {\n    return 1;\n  }\n}\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '## Guide\n\nFooService docs.\n', 'utf-8');

    const sym = symbolId('typescript', 'src/svc.ts::FooService', 'class');
    const docId = docSectionId('docs/guide.md', 'Guide');
    upsertSymbol(db, { id: sym, name: 'FooService', kind: 'class', location: 'src/svc.ts:1' });
    upsertDocSection(db, { id: docId, file: 'docs/guide.md', anchor: 'Guide', doc_type: 'standalone', status: 'in_sync' });
    createMapping(db, { symbol_id: sym, doc_id: docId, rel_type: 'describes' });

    const report = docrelayReview(db, tmpDir);
    const out = formatReviewDetailed(report, tmpDir);

    expect(out).toContain('## DocRelay Review — Detailed');
    expect(out).toContain('### Unreviewed Mappings (1)');
    expect(out).toContain('`FooService` ↔ docs/guide.md#Guide');
    expect(out).toContain('SOURCE');
    expect(out).toContain('class FooService');
    expect(out).toContain('FooService docs.');
    expect(out).toContain(`docrelay confirm --symbol ${sym} --doc ${docId}`);
    expect(out).toContain(`docrelay reject --symbol ${sym} --doc ${docId}`);
  });

  it('falls back gracefully when src/ or the doc anchor is missing in detailed mode', () => {
    const report = docrelayReview(db, tmpDir);
    report.unreviewedMappings.push({
      symbolId: 'ghost-sym',
      symbolName: 'Ghost',
      docId: 'ghost-doc',
      docFile: 'docs/nope.md',
      docAnchor: 'Missing',
      reviewStatus: 'auto',
      relType: 'describes',
    });
    report.summary.unreviewedCount = 1;

    const out = formatReviewDetailed(report, tmpDir);
    expect(out).toContain('(symbol "Ghost" source not found)');
    expect(out).toContain('(invalid path: docs/nope.md)');
  });

  it('renders implied references, unreviewed mappings, and orphaned sections', () => {
    const report = docrelayReview(db, tmpDir);
    report.impliedReferences.push({
      symbolName: 'Foo', docFile: 'docs/a.md', docAnchor: 'A', mentionLine: 3, mentionText: 'Foo here',
    });
    report.unreviewedMappings.push({
      symbolId: 's1', symbolName: 'Foo', docId: 'd1', docFile: 'docs/a.md',
      docAnchor: 'A', reviewStatus: 'auto', relType: 'describes',
    });
    report.orphanedSections.push({ id: 'o1', file: 'docs/b.md', anchor: '' });

    const out = formatReview(report);

    expect(out).toContain('### Implied References (1)');
    expect(out).toContain('`Foo` → docs/a.md#A (line 3)');
    expect(out).toContain('### Unreviewed Mappings (1)');
    expect(out).toContain('[auto] `Foo` ↔ docs/a.md#A (describes)');
    expect(out).toContain('### Orphaned Sections (1)');
    expect(out).toContain('docs/b.md#(top)');
  });

  it('caps detailed rendering at 200 mappings with an overflow note', () => {
    const report = docrelayReview(db, tmpDir);
    for (let i = 0; i < 201; i++) {
      report.unreviewedMappings.push({
        symbolId: `s${i}`, symbolName: `Sym${i}`, docId: `d${i}`,
        docFile: 'docs/nope.md', docAnchor: 'X', reviewStatus: 'auto', relType: 'describes',
      });
    }
    report.summary.unreviewedCount = 201;

    const out = formatReviewDetailed(report, tmpDir);

    expect(out).toContain('### Unreviewed Mappings (201)');
    expect(out).toContain('_Showing 200 of 201 unreviewed mappings.');
    expect(out).not.toContain('Sym200` ↔');
  });

  it('reports when no src/ directory exists for source snippets', () => {
    fs.rmSync(path.join(tmpDir, 'src'), { recursive: true, force: true });
    const report = docrelayReview(db, tmpDir);
    report.unreviewedMappings.push({
      symbolId: 's1', symbolName: 'Widget', docId: 'd1',
      docFile: 'docs/nope.md', docAnchor: 'X', reviewStatus: 'auto', relType: 'describes',
    });

    const out = formatReviewDetailed(report, tmpDir);

    expect(out).toContain('(no src/ directory found)');
  });

  it('finds symbols in nested src subdirectories', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'deep', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'deep', 'nested', 'widget.ts'), 'export class Widget {}\n', 'utf-8');
    const report = docrelayReview(db, tmpDir);
    report.unreviewedMappings.push({
      symbolId: 's1', symbolName: 'Widget', docId: 'd1',
      docFile: 'docs/nope.md', docAnchor: 'X', reviewStatus: 'auto', relType: 'describes',
    });

    const out = formatReviewDetailed(report, tmpDir);

    expect(out).toContain(`// src${path.sep}deep${path.sep}nested${path.sep}widget.ts:1`);
    expect(out).toContain('class Widget');
  });

  it('skips oversized source files during snippet extraction', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'big.ts'),
      '// header\n' + 'x'.repeat(10 * 1024 * 1024) + '\nexport class Widget {}\n',
      'utf-8',
    );
    const report = docrelayReview(db, tmpDir);
    report.unreviewedMappings.push({
      symbolId: 's1', symbolName: 'Widget', docId: 'd1',
      docFile: 'docs/nope.md', docAnchor: 'X', reviewStatus: 'auto', relType: 'describes',
    });

    const out = formatReviewDetailed(report, tmpDir);

    // The 10 MB+ file is skipped, so the symbol is reported as not found.
    expect(out).toContain('(symbol "Widget" source not found)');
  });

  it('reports source files exceeding the snippet line cap', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'lines.ts'),
      '// filler\n'.repeat(100_000) + 'export class Widget {}\n',
      'utf-8',
    );
    const report = docrelayReview(db, tmpDir);
    report.unreviewedMappings.push({
      symbolId: 's1', symbolName: 'Widget', docId: 'd1',
      docFile: 'docs/nope.md', docAnchor: 'X', reviewStatus: 'auto', relType: 'describes',
    });

    const out = formatReviewDetailed(report, tmpDir);

    expect(out).toContain('file exceeds 100000 lines');
  });

  it('falls back to the first textual occurrence when no definition pattern matches', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'note.ts'),
      '// Widget is mentioned here but never defined\nexport const unrelated = 1;\n',
      'utf-8',
    );
    const report = docrelayReview(db, tmpDir);
    report.unreviewedMappings.push({
      symbolId: 's1', symbolName: 'Widget', docId: 'd1',
      docFile: 'docs/nope.md', docAnchor: 'X', reviewStatus: 'auto', relType: 'describes',
    });

    const out = formatReviewDetailed(report, tmpDir);

    expect(out).toContain(`// src${path.sep}note.ts:1`);
    expect(out).toContain('Widget is mentioned here');
  });

  it('handles doc snippet guards: oversized, line cap, missing anchor, and header fallback', () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'big.md'), 'x'.repeat(10 * 1024 * 1024 + 1), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'lines.md'), '## A\n\n' + 'x\n'.repeat(100_001), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'm.md'), '## Present\n\nbody\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'plain.md'), '# Title\n\nfirst paragraph\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'mid.md'), '# Top\n\nstuff\n\n## Guide\n\nBody\n', 'utf-8');

    const report = docrelayReview(db, tmpDir);
    const push = (symbolName: string, docFile: string, docAnchor: string) => {
      report.unreviewedMappings.push({
        symbolId: `s-${symbolName}-${docFile}`, symbolName, docId: `d-${docFile}#${docAnchor}`,
        docFile, docAnchor, reviewStatus: 'auto', relType: 'describes',
      });
    };
    push('BigDoc', 'docs/big.md', 'A');
    push('ManyLines', 'docs/lines.md', 'A');
    push('NoAnchor', 'docs/m.md', 'Missing');
    push('HeaderDoc', 'docs/plain.md', '');
    push('MidDoc', 'docs/mid.md', 'Guide');

    const out = formatReviewDetailed(report, tmpDir);

    expect(out).toContain('(file too large: docs/big.md)');
    expect(out).toContain('(file exceeds 100000 lines: docs/lines.md)');
    expect(out).toContain('(anchor "Missing" not found in docs/m.md)');
    expect(out).toContain('// docs/plain.md');
    expect(out).toContain('first paragraph');
    // The heading is on line 5 (1-based) — guards the off-by-one fix.
    expect(out).toContain('// docs/mid.md:5');
  });
});
