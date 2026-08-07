import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { cleanupOrphans } from '../../src/tools/review.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('review --cleanup (cleanupOrphans)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cleanup-'));
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

  it('deletes orphaned doc_sections (missing files) with cascaded mappings, keeps healthy ones', () => {
    const orphanDocId = docSectionId('docs/gone.md', '');
    const healthyDocId = docSectionId('docs/real.md', '');
    const symA = symbolId('typescript', 'src/a.ts::Foo', 'class');
    const symB = symbolId('typescript', 'src/b.ts::Bar', 'class');

    // Orphaned section: its backing file does not exist on disk.
    upsertDocSection(db, {
      id: orphanDocId,
      file: 'docs/gone.md',
      anchor: '',
      doc_type: 'standalone',
      status: 'in_sync',
    });
    // Healthy section: backing file exists.
    fs.writeFileSync(path.join(tmpDir, 'docs', 'real.md'), '# Real\n', 'utf-8');
    upsertDocSection(db, {
      id: healthyDocId,
      file: 'docs/real.md',
      anchor: '',
      doc_type: 'standalone',
      status: 'in_sync',
    });

    upsertSymbol(db, { id: symA, name: 'Foo', kind: 'class', location: 'src/a.ts:1' });
    upsertSymbol(db, { id: symB, name: 'Bar', kind: 'class', location: 'src/b.ts:1' });
    createMapping(db, { symbol_id: symA, doc_id: orphanDocId, rel_type: 'describes' });
    createMapping(db, { symbol_id: symB, doc_id: orphanDocId, rel_type: 'references' });
    createMapping(db, { symbol_id: symB, doc_id: healthyDocId, rel_type: 'describes' });

    const result = cleanupOrphans(db, tmpDir);

    expect(result.orphanedSectionsRemoved).toBe(1);
    expect(result.cascadedMappingsRemoved).toBe(2);
    expect(result.rejectedMappingsRemoved).toBe(0);

    // Orphan section + its mappings gone.
    expect(db.prepare('SELECT COUNT(*) AS c FROM doc_sections WHERE id = ?').get(orphanDocId)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings WHERE doc_id = ?').get(orphanDocId)).toEqual({ c: 0 });
    // Healthy section and mapping preserved.
    expect(db.prepare('SELECT COUNT(*) AS c FROM doc_sections WHERE id = ?').get(healthyDocId)).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings WHERE doc_id = ?').get(healthyDocId)).toEqual({ c: 1 });
  });

  it('deletes rejected mappings older than 30 days, keeps recent rejected and non-rejected ones', () => {
    const symA = symbolId('typescript', 'src/a.ts::Foo', 'class');
    const symB = symbolId('typescript', 'src/b.ts::Bar', 'class');
    const docA = docSectionId('docs/a.md', '');
    const docB = docSectionId('docs/b.md', '');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '# A\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '# B\n', 'utf-8');

    upsertSymbol(db, { id: symA, name: 'Foo', kind: 'class', location: 'src/a.ts:1' });
    upsertSymbol(db, { id: symB, name: 'Bar', kind: 'class', location: 'src/b.ts:1' });
    upsertDocSection(db, { id: docA, file: 'docs/a.md', anchor: '', doc_type: 'standalone', status: 'in_sync' });
    upsertDocSection(db, { id: docB, file: 'docs/b.md', anchor: '', doc_type: 'standalone', status: 'in_sync' });

    // One rejected mapping old enough to prune (40 days ago).
    db.prepare(
      `INSERT INTO mappings (symbol_id, doc_id, rel_type, review_status, created_at)
       VALUES (?, ?, 'describes', 'rejected', datetime('now', '-40 days'))`,
    ).run(symA, docA);
    // One rejected mapping too recent (5 days ago) — must survive.
    db.prepare(
      `INSERT INTO mappings (symbol_id, doc_id, rel_type, review_status, created_at)
       VALUES (?, ?, 'describes', 'rejected', datetime('now', '-5 days'))`,
    ).run(symB, docB);
    // One old but non-rejected mapping (auto) — must survive.
    db.prepare(
      `INSERT INTO mappings (symbol_id, doc_id, rel_type, review_status, created_at)
       VALUES (?, ?, 'references', 'auto', datetime('now', '-40 days'))`,
    ).run(symB, docA);

    const result = cleanupOrphans(db, tmpDir);

    expect(result.rejectedMappingsRemoved).toBe(1);
    expect(result.orphanedSectionsRemoved).toBe(0);

    // Old rejected removed; recent rejected and auto retained.
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings WHERE symbol_id = ? AND doc_id = ?').get(symA, docA)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings WHERE symbol_id = ? AND doc_id = ?').get(symB, docB)).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings WHERE symbol_id = ? AND doc_id = ?').get(symB, docA)).toEqual({ c: 1 });
  });
});
