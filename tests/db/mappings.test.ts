import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection, markDocStale } from '../../src/db/docs.js';
import {
  createMapping,
  getMappingsForSymbol,
  getMappingsForDoc,
  setReviewStatus,
  deleteMapping,
  exportMappingsJson,
} from '../../src/db/mappings.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('doc_sections and mappings CRUD', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const symId = symbolId('typescript', 'src/auth::login', 'function');
  const docId = docSectionId('docs/api.md', 'authentication');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42', signature: 'abc' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'authentication', doc_type: 'standalone' });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('doc_sections', () => {
    it('upserts and retrieves a doc section', () => {
      const doc = getDocSection(db, docId);
      expect(doc).toBeDefined();
      expect(doc!.file).toBe('docs/api.md');
      expect(doc!.doc_type).toBe('standalone');
    });

    it('markDocStale sets status to stale', () => {
      markDocStale(db, docId);
      const doc = getDocSection(db, docId);
      expect(doc!.status).toBe('stale');
    });
  });

  describe('mappings', () => {
    it('creates a mapping between symbol and doc', () => {
      const mapping = createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      expect(mapping.symbol_id).toBe(symId);
      expect(mapping.doc_id).toBe(docId);
      expect(mapping.rel_type).toBe('describes');
    });

    it('returns mappings for a symbol', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      const mappings = getMappingsForSymbol(db, symId);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].doc_id).toBe(docId);
    });

    it('returns mappings for a doc', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      const mappings = getMappingsForDoc(db, docId);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].symbol_id).toBe(symId);
    });

    it('deletes a specific mapping', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      deleteMapping(db, symId, docId, 'describes');
      expect(getMappingsForSymbol(db, symId)).toHaveLength(0);
    });

    it('cascades delete when symbol is deleted', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      db.prepare('DELETE FROM symbols WHERE id = ?').run(symId);
      expect(getMappingsForSymbol(db, symId)).toHaveLength(0);
    });
  });
});

describe('mapping confidence (schema v6)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-mapconf-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: 's1', name: 'login', kind: 'function' });
    upsertDocSection(db, { id: 'd1', file: 'docs/a.md', anchor: 'A', doc_type: 'standalone' });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to 1.0 when no confidence is given (manual/legacy links)', () => {
    const row = createMapping(db, { symbol_id: 's1', doc_id: 'd1', rel_type: 'describes' });
    expect(row.confidence).toBe(1.0);
  });

  it('stores the auto-link evidence score on create', () => {
    const row = createMapping(db, { symbol_id: 's1', doc_id: 'd1', rel_type: 'describes', confidence: 0.4 });
    expect(row.confidence).toBe(0.4);
  });

  it('refreshes the score on conflict when a new one is carried', () => {
    createMapping(db, { symbol_id: 's1', doc_id: 'd1', rel_type: 'describes', confidence: 0.9 });
    const row = createMapping(db, { symbol_id: 's1', doc_id: 'd1', rel_type: 'describes', confidence: 0.4 });
    expect(row.confidence).toBe(0.4);
  });

  it('preserves the stored score on conflict when none is carried', () => {
    createMapping(db, { symbol_id: 's1', doc_id: 'd1', rel_type: 'describes', confidence: 0.4 });
    const row = createMapping(db, { symbol_id: 's1', doc_id: 'd1', rel_type: 'describes' });
    expect(row.confidence).toBe(0.4);
  });
});

describe('mapping guards and export', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-dbmappings-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty results for empty lookup ids', () => {
    expect(getMappingsForSymbol(db, '')).toEqual([]);
    expect(getMappingsForDoc(db, '')).toEqual([]);
  });

  it('setReviewStatus returns null for empty ids', () => {
    expect(setReviewStatus(db, '', 'doc', 'describes', 'confirmed')).toBeNull();
    expect(setReviewStatus(db, 'sym', '', 'describes', 'confirmed')).toBeNull();
  });

  it('deleteMapping returns false for empty ids', () => {
    expect(deleteMapping(db, '', 'doc', 'describes')).toBe(false);
    expect(deleteMapping(db, 'sym', '', 'describes')).toBe(false);
  });

  it('exportMappingsJson joins symbol and doc columns', () => {
    const sym = symbolId('typescript', 'src/a.ts::Login', 'class');
    const doc = docSectionId('docs/guide.md', 'Guide');
    upsertSymbol(db, { id: sym, name: 'Login', kind: 'class', location: 'src/a.ts:1' });
    upsertDocSection(db, { id: doc, file: 'docs/guide.md', anchor: 'Guide', doc_type: 'standalone' });
    createMapping(db, { symbol_id: sym, doc_id: doc, rel_type: 'describes', review_status: 'confirmed' });

    expect(exportMappingsJson(db)).toEqual([{
      symbol_name: 'Login',
      doc_file: 'docs/guide.md',
      doc_anchor: 'Guide',
      rel_type: 'describes',
      review_status: 'confirmed',
    }]);
  });
});
