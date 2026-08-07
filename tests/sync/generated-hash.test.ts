import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the generated-doc driver so the test can simulate a successfully
// regenerated file without spawning a real generator binary.
const { mockUpdateGeneratedDoc, mockDetectGenerator } = vi.hoisted(() => ({
  mockUpdateGeneratedDoc: vi.fn(),
  mockDetectGenerator: vi.fn(),
}));

vi.mock('../../src/sync/generated.js', () => ({
  updateGeneratedDoc: mockUpdateGeneratedDoc,
  detectGenerator: mockDetectGenerator,
}));

const autoConfig: DocRelayConfig = {
  project: 'test',
  doc_dirs: ['docs'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'auto_update',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

describe('generated doc sync refresh content_hash', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let symId: string;
  let docId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-genhash-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    symId = symbolId('typescript', 'src/api.ts::ApiClient', 'class');
    docId = docSectionId('docs/api.md', '');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeAllDbs();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes content_hash to the regenerated file content after success', async () => {
    const docPath = path.join(tmpDir, 'docs', 'api.md');
    // Pre-regeneration file content (what the DB hash currently reflects).
    fs.writeFileSync(docPath, '# API\n\nOld content.\n', 'utf-8');
    const oldHash = contentHash(fs.readFileSync(docPath, 'utf-8'));

    upsertSymbol(db, {
      id: symId,
      name: 'ApiClient',
      kind: 'class',
      location: 'src/api.ts:1',
      signature: contentHash('export class ApiClient {}'),
      raw_signature: 'export class ApiClient {}',
    });
    upsertDocSection(db, {
      id: docId,
      file: 'docs/api.md',
      anchor: '',
      doc_type: 'generated',
      content_hash: oldHash,
      status: 'stale',
    });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'generates' });

    mockDetectGenerator.mockReturnValue('npm run docs:generate');
    // Generator "regenerates" the file with new content.
    const newContent = '# API\n\nFreshly generated content.\n';
    mockUpdateGeneratedDoc.mockReturnValue({ success: true, output: 'ok' });
    // Hook the mock to also rewrite the file on disk so the post-sync hash
    // recompute has something real to read.
    mockUpdateGeneratedDoc.mockImplementation(() => {
      fs.writeFileSync(docPath, newContent, 'utf-8');
      return { success: true, output: 'ok' };
    });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.docsUpdated).toContain('docs/api.md');
    expect(result.errors).toHaveLength(0);

    // content_hash must now match the actual regenerated file content.
    const doc = getDocSection(db, docId)!;
    expect(doc.content_hash).toBe(contentHash(fs.readFileSync(docPath, 'utf-8')));
    expect(doc.content_hash).toBe(contentHash(newContent));
    expect(doc.content_hash).not.toBe(oldHash);
  });

  it('keeps existing mark_stale behavior when no generator is detected', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '# API\n', 'utf-8');

    upsertSymbol(db, {
      id: symId,
      name: 'ApiClient',
      kind: 'class',
      location: 'src/api.ts:1',
      signature: contentHash('export class ApiClient {}'),
      raw_signature: 'export class ApiClient {}',
    });
    upsertDocSection(db, {
      id: docId,
      file: 'docs/api.md',
      anchor: '',
      doc_type: 'generated',
      content_hash: 'stale-hash',
      status: 'in_sync',
    });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'generates' });

    mockDetectGenerator.mockReturnValue(null);
    mockUpdateGeneratedDoc.mockReturnValue({ success: true, output: 'should not run' });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.docsStaled).toContain('docs/api.md');
    expect(mockUpdateGeneratedDoc).not.toHaveBeenCalled();
    const doc = getDocSection(db, docId)!;
    expect(doc.status).toBe('stale');
    expect(doc.content_hash).toBe('stale-hash');
  });
});
