// tests/tools/impact.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { docrelImpact } from '../../src/tools/impact.js';
import { docrelLink } from '../../src/tools/link.js';
import { docrelDiff } from '../../src/tools/diff.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockCodegraph = {
  explore: vi.fn().mockResolvedValue({
    symbols: [{ name: 'login', kind: 'function', file: 'src/auth.ts', line: 42 }],
    files: ['src/auth.ts'],
  }),
  impact: vi.fn().mockResolvedValue({ symbol: '', affected: [] }),
  search: vi.fn().mockResolvedValue({ items: [] }),
  connect: vi.fn().mockResolvedValue(undefined),
  isAvailable: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as CodegraphClient;

describe('docrelImpact', () => {
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

  it('finds affected docs when a linked symbol file changes', async () => {
    const symId = symbolId('ts', 'src/auth.ts::login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');

    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const impact = await docrelImpact(db, mockCodegraph, ['src/auth.ts']);
    expect(impact.affectedDocs).toHaveLength(1);
    expect(impact.affectedDocs[0].file).toBe('docs/api.md');
  });
});

describe('docrelLink', () => {
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

  it('creates a mapping between symbol and doc', () => {
    const symId = symbolId('ts', 'login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', doc_type: 'standalone' });

    const result = docrelLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(result.action).toBe('created');

    const mappings = db.prepare('SELECT * FROM mappings').all();
    expect(mappings).toHaveLength(1);
  });
});
