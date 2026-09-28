import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { docrelayLink } from '../../src/tools/link.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';

describe('docrelayLink', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const symId = symbolId('ts', 'src/auth.ts::login', 'function');
  const docId = docSectionId('docs/api.md', 'auth');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-link-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', doc_type: 'standalone' });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects empty symbol_id or doc_id', () => {
    const r1 = docrelayLink(db, { action: 'create', symbol_id: '', doc_id: docId, rel_type: 'describes' });
    expect(r1.action).toBe('error');
    expect(r1.message).toContain('must not be empty');
    const r2 = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: '', rel_type: 'describes' });
    expect(r2.action).toBe('error');
  });

  it('rejects an invalid rel_type', () => {
    const r = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'bogus' });
    expect(r.action).toBe('error');
    expect(r.message).toContain('Invalid rel_type');
  });

  it('creates mappings for every valid rel_type', () => {
    for (const relType of ['describes', 'references', 'generates', 'contracts']) {
      const r = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: relType });
      expect(r.action).toBe('created');
      expect(r.review_status).toBe('auto');
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings').get()).toEqual({ c: 4 });
  });

  it('treats duplicate create as an idempotent upsert (no duplicate row)', () => {
    docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    const dup = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(dup.action).toBe('created');
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings').get()).toEqual({ c: 1 });
  });

  it('explains when the symbol does not exist', () => {
    const r = docrelayLink(db, { action: 'create', symbol_id: 'no-such-symbol', doc_id: docId, rel_type: 'describes' });
    expect(r.action).toBe('error');
    expect(r.message).toContain('symbol not found');
  });

  it('explains when the doc section does not exist', () => {
    const r = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: 'no-such-doc', rel_type: 'describes' });
    expect(r.action).toBe('error');
    expect(r.message).toContain('doc section not found');
  });

  it('deletes an existing mapping and reports misses', () => {
    docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'references' });
    const del = docrelayLink(db, { action: 'delete', symbol_id: symId, doc_id: docId, rel_type: 'references' });
    expect(del.action).toBe('deleted');

    const miss = docrelayLink(db, { action: 'delete', symbol_id: symId, doc_id: docId, rel_type: 'references' });
    expect(miss.action).toBe('error');
    expect(miss.message).toContain('not found');
  });

  it('honors an explicit review_status on create', () => {
    const r = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes', review_status: 'confirmed' });
    expect(r.action).toBe('created');
    expect(r.review_status).toBe('confirmed');
  });
});
