import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertDocSection, markDocStale } from '../../src/db/docs.js';
import { docrelCheck } from '../../src/tools/check.js';
import { docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('docrelCheck', () => {
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

  it('passes when no stale docs', () => {
    const report = docrelCheck(db, true);
    expect(report.passed).toBe(true);
  });

  it('fails when there are stale docs in strict mode', () => {
    const docId = docSectionId('docs/api.md', 'auth');
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    markDocStale(db, docId);

    const report = docrelCheck(db, true);
    expect(report.passed).toBe(false);
    expect(report.staleDocs).toHaveLength(1);
  });
});
