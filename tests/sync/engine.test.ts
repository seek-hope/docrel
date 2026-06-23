import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
import type { DocRelConfig } from '../../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockCodegraph = {
  explore: vi.fn().mockResolvedValue({ symbols: [], files: [] }),
  impact: vi.fn().mockResolvedValue({ symbol: '', affected: [] }),
  search: vi.fn().mockResolvedValue({ items: [] }),
  connect: vi.fn().mockResolvedValue(undefined),
  isAvailable: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as CodegraphClient;

const testConfig: DocRelConfig = {
  project: 'test',
  doc_dirs: ['docs'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'mark_stale',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

describe('syncSymbol', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const symId = symbolId('typescript', 'src/auth::login', 'function');
  const docId = docSectionId('docs/api.md', 'authentication');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42', signature: 'abc123' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'authentication', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks standalone doc as stale when strategy is mark_stale', async () => {
    const result = await syncSymbol(db, mockCodegraph, testConfig, symId);
    expect(result.docsStaled).toContain('docs/api.md');

    const doc = getDocSection(db, docId);
    expect(doc!.status).toBe('stale');
  });

  it('returns empty result when symbol has no mappings', async () => {
    const orphanId = symbolId('typescript', 'orphan::fn', 'function');
    upsertSymbol(db, { id: orphanId, name: 'fn', kind: 'function' });
    const result = await syncSymbol(db, mockCodegraph, orphanId);
    expect(result.docsUpdated).toHaveLength(0);
    expect(result.docsStaled).toHaveLength(0);
  });
});
