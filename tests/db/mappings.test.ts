import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection, markDocStale } from '../../src/db/docs.js';
import {
  createMapping,
  getMappingsForSymbol,
  getMappingsForDoc,
  deleteMapping,
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsync-test-'));
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
