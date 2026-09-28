import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import {
  upsertDocSection,
  listDocSections,
  markDocStale,
  markDocsStaleForSymbol,
  markInlineStaleForSymbol,
  markDocRelayed,
  markDocRelayedWithHash,
} from '../../src/db/docs.js';
import { docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('db/docs', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-dbdocs-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects doc sections with missing required fields', () => {
    expect(() => upsertDocSection(db, { id: '', file: 'docs/a.md', doc_type: 'standalone' }))
      .toThrow('doc_section id cannot be empty');
    expect(() => upsertDocSection(db, { id: 'x', file: '', doc_type: 'standalone' }))
      .toThrow('doc_section file cannot be empty');
    expect(() => upsertDocSection(db, { id: 'x', file: 'docs/a.md', doc_type: '' as never }))
      .toThrow('doc_section doc_type cannot be empty');
  });

  it('lists doc sections with optional doc_type and status filters', () => {
    upsertDocSection(db, { id: docSectionId('docs/a.md', 'A'), file: 'docs/a.md', anchor: 'A', doc_type: 'standalone', status: 'in_sync' });
    upsertDocSection(db, { id: docSectionId('docs/b.md', ''), file: 'docs/b.md', anchor: '', doc_type: 'inline', status: 'stale' });

    expect(listDocSections(db)).toHaveLength(2);
    expect(listDocSections(db, { doc_type: 'inline' })).toHaveLength(1);
    expect(listDocSections(db, { doc_type: 'inline' })[0].file).toBe('docs/b.md');
    expect(listDocSections(db, { status: 'stale' })).toHaveLength(1);
    expect(listDocSections(db, { status: 'stale' })[0].anchor).toBe('');
    expect(listDocSections(db, { doc_type: 'standalone', status: 'stale' })).toHaveLength(0);
  });

  it('markDocStale warns and returns false for a missing doc', () => {
    expect(markDocStale(db, 'no-such-doc')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('markDocStale called for non-existent doc'));
  });

  it('markDocsStaleForSymbol returns [] for an empty symbol id', () => {
    expect(markDocsStaleForSymbol(db, '')).toEqual([]);
  });

  it('markInlineStaleForSymbol returns [] for an empty symbol id', () => {
    expect(markInlineStaleForSymbol(db, '')).toEqual([]);
  });

  it('markDocRelayed warns and returns false for a missing doc', () => {
    expect(markDocRelayed(db, 'no-such-doc')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('markDocRelayed called for non-existent doc'));
  });

  it('markDocRelayedWithHash warns and returns false for a missing doc', () => {
    expect(markDocRelayedWithHash(db, 'no-such-doc', 'hash')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('markDocRelayedWithHash called for non-existent doc'));
  });

  it('markDocRelayedWithHash updates hash and status atomically', () => {
    const id = docSectionId('docs/a.md', 'A');
    upsertDocSection(db, { id, file: 'docs/a.md', anchor: 'A', doc_type: 'standalone', status: 'stale', content_hash: 'old' });

    expect(markDocRelayedWithHash(db, id, 'new-hash')).toBe(true);
    const row = db.prepare('SELECT status, content_hash AS h FROM doc_sections WHERE id = ?').get(id) as { status: string; h: string };
    expect(row).toEqual({ status: 'in_sync', h: 'new-hash' });
  });
});
