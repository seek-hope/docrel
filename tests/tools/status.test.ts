import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { docrelStatus } from '../../src/tools/status.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('docrelStatus', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

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

  it('reports zeroes for empty database', () => {
    const status = docrelStatus(db);
    expect(status.totalSymbols).toBe(0);
    expect(status.linkedPercentage).toBe(0);
    expect(status.syncPercentage).toBe(100);
  });

  it('reports correct counts with data', () => {
    const symId = symbolId('ts', 'login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');

    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const status = docrelStatus(db);
    expect(status.totalSymbols).toBe(1);
    expect(status.linkedSymbols).toBe(1);
    expect(status.linkedPercentage).toBe(100);
  });
});
