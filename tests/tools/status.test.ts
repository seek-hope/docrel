import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { docrelayStatus } from '../../src/tools/status.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('docrelayStatus', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports zeroes for empty database', () => {
    const status = docrelayStatus(db);
    expect(status.totalSymbols).toBe(0);
    expect(status.linkedPercentage).toBe(0);
    expect(status.syncPercentage).toBe(0);
  });

  it('reports correct counts with data', () => {
    const symId = symbolId('ts', 'login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');

    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const status = docrelayStatus(db);
    expect(status.totalSymbols).toBe(1);
    expect(status.linkedSymbols).toBe(1);
    expect(status.linkedPercentage).toBe(100);
  });

  it('returns a sanitized zeroed report when the database query fails', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const proxy = {
      prepare(_sql: string): never { throw new Error('db exploded with /secret/path'); },
    } as unknown as Database.Database;
    const status = docrelayStatus(proxy);
    expect(status).toMatchObject({
      totalSymbols: 0, linkedSymbols: 0, linkedPercentage: 0,
      syncedDocs: 0, staleDocs: 0, totalDocs: 0,
      syncPercentage: 0, pendingChanges: 0, lastScan: null,
      error: 'Database query error — check server logs for details',
    });
    expect(errSpy).toHaveBeenCalledWith('docrelayStatus failed:', expect.any(Error));
  });
});
