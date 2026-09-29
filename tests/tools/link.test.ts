import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
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

  it('creates mappings for every valid rel_type (manual links default to confirmed)', () => {
    for (const relType of ['describes', 'references', 'generates', 'contracts']) {
      const r = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: relType });
      expect(r.action).toBe('created');
      expect(r.review_status).toBe('confirmed');
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings').get()).toEqual({ c: 4 });
  });

  it('creates a mapping from a bare symbol name and file#anchor', () => {
    upsertDocSection(db, { id: docSectionId('docs/api.md', 'login'), file: 'docs/api.md', anchor: 'login', doc_type: 'standalone' });
    const r = docrelayLink(db, { action: 'create', symbol_id: 'login', doc_id: 'docs/api.md#login', rel_type: 'describes' });
    expect(r.action).toBe('created');
    expect(r.symbol_id).toBe(symId);
    expect(r.doc_id).toBe(docSectionId('docs/api.md', 'login'));
  });

  it('creates a mapping from a unique bare doc anchor', () => {
    upsertDocSection(db, { id: docSectionId('docs/guide.md', 'authentication'), file: 'docs/guide.md', anchor: 'authentication', doc_type: 'standalone' });
    const r = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: 'authentication', rel_type: 'describes' });
    expect(r.action).toBe('created');
  });

  it('rejects an ambiguous bare symbol name with candidates', () => {
    upsertSymbol(db, { id: symbolId('ts', 'src/b.ts::login', 'function'), name: 'login', kind: 'function', location: 'src/b.ts:7' });
    const r = docrelayLink(db, { action: 'create', symbol_id: 'login', doc_id: docId, rel_type: 'describes' });
    expect(r.action).toBe('error');
    expect(r.message).toContain('matches 2 symbols');
    expect(r.message).toContain(symId);
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
    expect(r.message).toContain('Symbol not found: no-such-symbol');
  });

  it('explains when the doc section does not exist', () => {
    const r = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: 'no-such-doc', rel_type: 'describes' });
    expect(r.action).toBe('error');
    expect(r.message).toContain('Doc section not found: no-such-doc');
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

  it('reports a generic constraint violation when both endpoints exist', () => {
    // Both rows exist, so the diagnostic falls through to the generic message
    // (the CHECK on review_status is what actually fails here).
    const r = docrelayLink(db, {
      action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes',
      review_status: 'bogus' as never,
    });
    expect(r.action).toBe('error');
    expect(r.message).toBe('Cannot create mapping: constraint violation.');
  });

  it('survives a failing diagnostic query during constraint handling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proxy = {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO mappings')) {
          // createMapping reads the RETURNING row via .get(), so throw there.
          return { get: () => { throw Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' }); } };
        }
        if (sql.includes('SELECT 1 FROM symbols')) {
          throw Object.assign(new Error('db gone'), { code: 'SQLITE_BUSY' });
        }
        return db.prepare(sql);
      },
    } as unknown as Database.Database;
    const r = docrelayLink(proxy, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(r.action).toBe('error');
    expect(r.message).toBe('Constraint violation (diagnostic failed: SQLITE_BUSY)');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('diagnostic query during constraint handling failed'), 'db gone');
  });

  it('returns Internal DB error for non-constraint failures', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const proxy = {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO mappings')) {
          // createMapping reads the RETURNING row via .get(), so throw there.
          return { get: () => { throw new Error('disk full'); } };
        }
        return db.prepare(sql);
      },
    } as unknown as Database.Database;
    const r = docrelayLink(proxy, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(r).toMatchObject({ action: 'error', message: 'Internal DB error.' });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('docrelayLink create failed'), 'disk full');
  });
});

describe('docrelayConfirm / docrelayReject', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const symId = symbolId('ts', 'src/auth.ts::login', 'function');
  const docId = docSectionId('docs/api.md', 'auth');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-confirm-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', doc_type: 'standalone' });
    const { createMapping } = await import('../../src/db/mappings.js');
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('confirms a mapping addressed by bare symbol name and file#anchor', async () => {
    upsertDocSection(db, { id: docSectionId('docs/api.md', 'auth'), file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    const { docrelayConfirm, docrelayReject } = await import('../../src/tools/link.js');
    const confirmed = docrelayConfirm(db, 'login', 'docs/api.md#auth');
    expect(confirmed.action).toBe('updated');
    expect(confirmed.symbol_id).toBe(symId);
    expect(confirmed.doc_id).toBe(docId);
    const rejected = docrelayReject(db, 'login', 'auth');
    expect(rejected.action).toBe('updated');
    expect(rejected.review_status).toBe('rejected');
  });

  it('surfaces the resolver error when a name is unknown', async () => {
    const { docrelayConfirm } = await import('../../src/tools/link.js');
    const r = docrelayConfirm(db, 'ghost-symbol', docId);
    expect(r.action).toBe('error');
    expect(r.message).toContain('Symbol not found: ghost-symbol');
  });

  it('confirms a mapping and records it in review_history with default actor cli', async () => {
    const { docrelayConfirm } = await import('../../src/tools/link.js');
    const r = docrelayConfirm(db, symId, docId);
    expect(r.action).toBe('updated');
    expect(r.review_status).toBe('confirmed');

    const rows = db.prepare('SELECT * FROM review_history').all() as Array<{ action: string; actor: string; rel_type: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'confirmed', actor: 'cli', rel_type: 'describes' });
  });

  it('rejects a mapping and records it with a custom actor', async () => {
    const { docrelayReject } = await import('../../src/tools/link.js');
    const r = docrelayReject(db, symId, docId, 'describes', 'mcp');
    expect(r.action).toBe('updated');
    expect(r.review_status).toBe('rejected');

    const rows = db.prepare('SELECT * FROM review_history').all() as Array<{ action: string; actor: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'rejected', actor: 'mcp' });
  });

  it('records one history row per decision, including repeated flips', async () => {
    const { docrelayConfirm, docrelayReject } = await import('../../src/tools/link.js');
    docrelayConfirm(db, symId, docId);
    docrelayReject(db, symId, docId);
    docrelayConfirm(db, symId, docId);

    const rows = db.prepare('SELECT action FROM review_history ORDER BY id').all() as Array<{ action: string }>;
    expect(rows.map((r) => r.action)).toEqual(['confirmed', 'rejected', 'confirmed']);
  });

  it('records nothing when the mapping does not exist', async () => {
    const { docrelayConfirm } = await import('../../src/tools/link.js');
    const r = docrelayConfirm(db, symId, docId, 'references');
    expect(r.action).toBe('error');
    expect(db.prepare('SELECT COUNT(*) AS c FROM review_history').get()).toEqual({ c: 0 });
  });

  it('still confirms when the history insert fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proxy = {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO review_history')) {
          return { run: () => { throw new Error('history table gone'); } };
        }
        return db.prepare(sql);
      },
    } as unknown as Database.Database;
    const { docrelayConfirm } = await import('../../src/tools/link.js');
    const r = docrelayConfirm(proxy, symId, docId);
    expect(r).toMatchObject({ action: 'updated', review_status: 'confirmed' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to record review history'), 'history table gone');
    // The mapping update itself must have succeeded despite the history failure.
    expect(db.prepare("SELECT review_status AS s FROM mappings WHERE symbol_id = ? AND doc_id = ?").get(symId, docId)).toEqual({ s: 'confirmed' });
  });

  it('rejects empty ids without touching history', async () => {
    const { docrelayConfirm, docrelayReject } = await import('../../src/tools/link.js');
    expect(docrelayConfirm(db, '', docId).action).toBe('error');
    expect(docrelayReject(db, symId, '').action).toBe('error');
    expect(db.prepare('SELECT COUNT(*) AS c FROM review_history').get()).toEqual({ c: 0 });
  });
});
