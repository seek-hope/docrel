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
});
