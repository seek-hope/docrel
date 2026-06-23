import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { loadConfig } from '../../src/utils/config.js';
import { docrelStatus } from '../../src/tools/status.js';
import { docrelCheck } from '../../src/tools/check.js';
import { docrelLink } from '../../src/tools/link.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DocRel E2E', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-e2e-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.docrel'), { recursive: true });

    // Copy fixtures
    fs.cpSync(
      path.join(process.cwd(), 'fixtures', 'sample-project'),
      tmpDir,
      { recursive: true },
    );

    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full workflow: scan → link → check → detect change → mark stale', () => {
    // 1. Manually register a symbol (simulating auto-discovery)
    const symId = symbolId('typescript', 'src/auth.ts::login', 'function');
    upsertSymbol(db, {
      id: symId,
      name: 'login',
      kind: 'function',
      project: 'src',
      location: 'src/auth.ts:9',
      signature: 'abc123',
    });

    // 2. Register a doc section
    const docId = docSectionId('docs/api.md', 'Authentication');
    upsertDocSection(db, {
      id: docId,
      file: 'docs/api.md',
      anchor: 'Authentication',
      doc_type: 'standalone',
      content_hash: 'def456',
    });

    // 3. Link them
    const result = docrelLink(db, {
      action: 'create',
      symbol_id: symId,
      doc_id: docId,
      rel_type: 'describes',
    });
    expect(result.action).toBe('created');

    // 4. Status shows linked
    const status = docrelStatus(db);
    expect(status.linkedSymbols).toBe(1);
    expect(status.linkedPercentage).toBe(100);

    // 5. Check passes (doc is in_sync)
    const checkBefore = docrelCheck(db, true);
    expect(checkBefore.passed).toBe(true);

    // 6. Simulate code change — mark doc stale
    db.prepare("UPDATE doc_sections SET status = 'stale' WHERE id = ?").run(docId);

    // 7. Check fails in strict mode
    const checkAfter = docrelCheck(db, true);
    expect(checkAfter.passed).toBe(false);
    expect(checkAfter.staleDocs).toHaveLength(1);
    expect(checkAfter.staleDocs[0].file).toBe('docs/api.md');
  });
});
