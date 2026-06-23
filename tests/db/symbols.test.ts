import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol, getSymbol, listSymbols, deleteSymbol, markSignatureChanged } from '../../src/db/symbols.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('symbolId', () => {
  it('generates a stable 64-char hex string', () => {
    const id = symbolId('typescript', 'src/auth::login', 'function');
    expect(id).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(id)).toBe(true);
  });

  it('is deterministic — same inputs produce same id', () => {
    const a = symbolId('typescript', 'src/auth::login', 'function');
    const b = symbolId('typescript', 'src/auth::login', 'function');
    expect(a).toBe(b);
  });

  it('differs when language differs', () => {
    const ts = symbolId('typescript', 'login', 'function');
    const py = symbolId('python', 'login', 'function');
    expect(ts).not.toBe(py);
  });

  it('differs when kind differs', () => {
    const fn = symbolId('typescript', 'login', 'function');
    const cls = symbolId('typescript', 'login', 'class');
    expect(fn).not.toBe(cls);
  });

  it('normalizes FQN whitespace', () => {
    const a = symbolId('typescript', '  src/auth::login  ', 'function');
    const b = symbolId('typescript', 'src/auth::login', 'function');
    expect(a).toBe(b);
  });
});

describe('docSectionId', () => {
  it('generates a stable 64-char hex string', () => {
    const id = docSectionId('docs/api.md', 'authentication');
    expect(id).toHaveLength(64);
  });

  it('is deterministic', () => {
    const a = docSectionId('docs/api.md', 'authentication');
    const b = docSectionId('docs/api.md', 'authentication');
    expect(a).toBe(b);
  });
});

describe('symbols CRUD', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const testSymbol = {
    id: symbolId('typescript', 'src/auth::login', 'function'),
    name: 'login',
    kind: 'function' as const,
    project: 'src/auth',
    location: 'src/auth.ts:42',
    signature: 'abc123',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('upsertSymbol', () => {
    it('inserts a new symbol', () => {
      const row = upsertSymbol(db, testSymbol);
      expect(row.id).toBe(testSymbol.id);
      expect(row.name).toBe('login');
    });

    it('updates an existing symbol by id', () => {
      upsertSymbol(db, testSymbol);
      const updated = upsertSymbol(db, { ...testSymbol, location: 'src/auth.ts:88', signature: 'def456' });
      expect(updated.location).toBe('src/auth.ts:88');
      expect(updated.signature).toBe('def456');

      const fetched = getSymbol(db, testSymbol.id);
      expect(fetched?.signature).toBe('def456');
    });
  });

  describe('getSymbol', () => {
    it('returns undefined for non-existent symbol', () => {
      expect(getSymbol(db, 'nonexistent')).toBeUndefined();
    });

    it('returns the inserted symbol', () => {
      upsertSymbol(db, testSymbol);
      const row = getSymbol(db, testSymbol.id);
      expect(row).toBeDefined();
      expect(row!.name).toBe('login');
    });
  });

  describe('listSymbols', () => {
    it('returns all symbols when no filter', () => {
      upsertSymbol(db, testSymbol);
      upsertSymbol(db, { ...testSymbol, id: symbolId('typescript', 'src/auth::logout', 'function'), name: 'logout' });
      expect(listSymbols(db)).toHaveLength(2);
    });

    it('filters by kind', () => {
      upsertSymbol(db, testSymbol);
      upsertSymbol(db, { ...testSymbol, id: symbolId('typescript', 'Auth', 'class'), name: 'Auth', kind: 'class' });
      expect(listSymbols(db, { kind: 'class' })).toHaveLength(1);
    });

    it('filters by project', () => {
      upsertSymbol(db, testSymbol);
      upsertSymbol(db, { ...testSymbol, id: symbolId('typescript', 'other::fn', 'function'), project: 'other' });
      expect(listSymbols(db, { project: 'src/auth' })).toHaveLength(1);
    });
  });

  describe('deleteSymbol', () => {
    it('removes the symbol from the database', () => {
      upsertSymbol(db, testSymbol);
      deleteSymbol(db, testSymbol.id);
      expect(getSymbol(db, testSymbol.id)).toBeUndefined();
    });
  });

  describe('markSignatureChanged', () => {
    it('records a changelog entry and updates the symbol signature', () => {
      upsertSymbol(db, testSymbol);
      markSignatureChanged(db, testSymbol.id, 'abc123', 'new456');

      const updated = getSymbol(db, testSymbol.id);
      expect(updated?.signature).toBe('new456');

      const log = db.prepare('SELECT * FROM changelog WHERE symbol_id = ?').get(testSymbol.id) as any;
      expect(log.change_type).toBe('signature_changed');
      expect(log.old_sig).toBe('abc123');
      expect(log.new_sig).toBe('new456');
    });
  });
});
