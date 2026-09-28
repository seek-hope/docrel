import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations, SCHEMA_VERSION } from '../../src/db/schema.js';
import { recordReviewAction, listReviewHistory } from '../../src/db/review-history.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';

describe('review_history db layer', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const symId = symbolId('ts', 'src/auth.ts::login', 'function');
  const docId = docSectionId('docs/api.md', 'auth');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-rh-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the review_history table at the current schema version', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('review_history');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('records and lists a review action, newest first', () => {
    recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'confirmed' });
    recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'rejected', actor: 'mcp' });

    const rows = listReviewHistory(db);
    expect(rows).toHaveLength(2);
    // Newest (rejected via mcp) first.
    expect(rows[0].action).toBe('rejected');
    expect(rows[0].actor).toBe('mcp');
    expect(rows[1].action).toBe('confirmed');
    expect(rows[1].actor).toBe('cli'); // default actor
    expect(rows[0].created_at).toBeTruthy();
  });

  it('enriches rows with symbol name and doc file/anchor', () => {
    recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'confirmed' });
    const [row] = listReviewHistory(db);
    expect(row.symbol_name).toBe('login');
    expect(row.doc_file).toBe('docs/api.md');
    expect(row.doc_anchor).toBe('auth');
  });

  it('survives deletion of the mapping, symbol, and doc section (no FK)', () => {
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'confirmed' });

    // Deleting the symbol cascades to mappings; history must remain.
    db.prepare('DELETE FROM symbols WHERE id = ?').run(symId);
    db.prepare('DELETE FROM doc_sections WHERE id = ?').run(docId);
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings').get()).toEqual({ c: 0 });

    const rows = listReviewHistory(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol_id).toBe(symId);
    expect(rows[0].symbol_name).toBeNull();
    expect(rows[0].doc_file).toBeNull();
    expect(rows[0].doc_anchor).toBeNull();
  });

  it('rejects an invalid action via CHECK constraint', () => {
    expect(() =>
      recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'bogus' as never }),
    ).toThrow();
  });

  it('filters by symbol_id', () => {
    const otherSym = symbolId('ts', 'src/auth.ts::logout', 'function');
    upsertSymbol(db, { id: otherSym, name: 'logout', kind: 'function' });
    recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'confirmed' });
    recordReviewAction(db, { symbol_id: otherSym, doc_id: docId, rel_type: 'describes', action: 'rejected' });

    const rows = listReviewHistory(db, { symbol_id: otherSym });
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol_id).toBe(otherSym);
    expect(rows[0].action).toBe('rejected');
  });

  it('respects the limit and clamps out-of-range values', () => {
    for (let i = 0; i < 5; i++) {
      recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'confirmed' });
    }
    expect(listReviewHistory(db, { limit: 3 })).toHaveLength(3);
    expect(listReviewHistory(db, { limit: 0 })).toHaveLength(1); // clamped to >= 1
    expect(listReviewHistory(db, { limit: 99999 })).toHaveLength(5); // clamped to max
  });

  it('upgrades a v4 database: table created, version bumped, data preserved', () => {
    // Simulate a v4 database: drop the table and rewind user_version.
    db.prepare('DROP TABLE review_history').run();
    db.pragma('user_version = 4');
    recordV4Row();

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('review_history');
    // Pre-existing mapping survived the migration.
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings').get()).toEqual({ c: 1 });
    // And history recording works on the upgraded DB.
    recordReviewAction(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', action: 'confirmed' });
    expect(listReviewHistory(db)).toHaveLength(1);
  });

  function recordV4Row(): void {
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
  }
});
