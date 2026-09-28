import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { docrelayHistory, formatHistoryMarkdown } from '../../src/tools/history.js';
import { docrelayConfirm, docrelayReject } from '../../src/tools/link.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';

describe('docrelayHistory', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const symId = symbolId('ts', 'src/auth.ts::login', 'function');
  const docId = docSectionId('docs/api.md', 'auth');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-hist-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty list when no decisions were recorded', () => {
    const r = docrelayHistory(db);
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it('lists confirm/reject decisions recorded through the link tools', () => {
    docrelayConfirm(db, symId, docId);
    docrelayReject(db, symId, docId);

    const r = docrelayHistory(db);
    expect(r.ok).toBe(true);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].action).toBe('rejected');
    expect(r.entries[1].action).toBe('confirmed');
    expect(r.entries[0].symbol_name).toBe('login');
    expect(r.entries[0].doc_file).toBe('docs/api.md');
  });

  it('fails gracefully on a closed database', () => {
    db.close();
    const r = docrelayHistory(db);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Database query error');
    expect(r.entries).toEqual([]);
  });
});

describe('formatHistoryMarkdown', () => {
  it('renders an empty-state message for no entries', () => {
    const md = formatHistoryMarkdown([]);
    expect(md).toContain('(0 entries)');
    expect(md).toContain('no review decisions recorded yet');
  });

  it('renders a table with symbol/doc names when available', () => {
    const md = formatHistoryMarkdown([{
      id: 1, symbol_id: 'sym-1', doc_id: 'doc-1', rel_type: 'describes',
      action: 'confirmed', actor: 'cli', created_at: '2026-09-28 10:00:00',
      symbol_name: 'login', doc_file: 'docs/api.md', doc_anchor: 'auth',
    }]);
    expect(md).toContain('| Timestamp | Action | Symbol | Document | Rel | Actor |');
    expect(md).toContain('confirmed');
    expect(md).toContain('login (`sym-1`)');
    expect(md).toContain('`docs/api.md#auth`');
  });

  it('falls back to raw ids for deleted symbols/docs', () => {
    const md = formatHistoryMarkdown([{
      id: 2, symbol_id: 'gone-sym', doc_id: 'gone-doc', rel_type: 'references',
      action: 'rejected', actor: 'mcp', created_at: '2026-09-28 11:00:00',
      symbol_name: null, doc_file: null, doc_anchor: null,
    }]);
    expect(md).toContain('`gone-sym`');
    expect(md).toContain('`gone-doc`');
    expect(md).toContain('rejected');
    expect(md).toContain('mcp');
  });
});
