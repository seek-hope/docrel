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

  it('surfaces watch failure markers when projectRoot is given', () => {
    const dir = path.join(tmpDir, '.docrelay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'watch-failed'), JSON.stringify({ at: '2026-09-29T00:00:00Z', error: 'disk full' }));
    fs.writeFileSync(path.join(dir, 'watch-crashed'), JSON.stringify({ at: '2026-09-29T00:01:00Z', eventsProcessed: 3, errorsEncountered: 1 }));

    const status = docrelayStatus(db, tmpDir);
    expect(status.watch?.failed?.error).toBe('disk full');
    expect(status.watch?.crashed?.eventsProcessed).toBe(3);
  });

  it('omits watch markers when none exist, when unreadable, or when no projectRoot is given', () => {
    const clean = docrelayStatus(db, tmpDir);
    expect(clean.watch).toBeUndefined();

    const dir = path.join(tmpDir, '.docrelay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'watch-failed'), 'not json {');
    const broken = docrelayStatus(db, tmpDir);
    expect(broken.watch).toBeUndefined();

    fs.unlinkSync(path.join(dir, 'watch-failed'));
    fs.writeFileSync(path.join(dir, 'watch-crashed'), JSON.stringify({ at: 'x' }));
    const noRoot = docrelayStatus(db);
    expect(noRoot.watch).toBeUndefined();
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
    // stderr receives the message only (no raw Error/stack) unless
    // DOCRELAY_DEBUG is set — the MCP-facing payload stays generic.
    expect(errSpy).toHaveBeenCalledWith('DocRelay: docrelayStatus failed:', 'db.transaction is not a function');
    expect(errSpy).not.toHaveBeenCalledWith(expect.anything(), expect.any(Error));
  });
});
