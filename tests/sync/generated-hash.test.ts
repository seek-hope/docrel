import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import type Database from 'better-sqlite3';
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

/** A db wrapper whose prepare() returns zero-change results for statements
 *  containing `match` (mark* helpers see "doc deleted concurrently"). */
function proxyDb(db: Database.Database, match: string): Database.Database {
  return {
    prepare(sql: string) {
      if (sql.includes(match)) {
        return {
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
          all: () => [],
          get: () => undefined,
        };
      }
      return db.prepare(sql);
    },
  } as unknown as Database.Database;
}

const autoConfig: DocRelayConfig = {
  version: 1,
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

  it('surfaces the generator output when regeneration fails', async () => {
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

    mockDetectGenerator.mockReturnValue('npm run docs:generate');
    mockUpdateGeneratedDoc.mockReturnValue({ success: false, output: 'typedoc exited 1' });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.errors.some((e) => e.includes('Failed to regenerate') && e.includes('typedoc exited 1'))).toBe(true);
    expect(result.docsUpdated).toHaveLength(0);
    // Doc must not be marked synced on failure.
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
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

describe('generated doc sync — post-regeneration read failures', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let symId: string;
  let docId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-genfail-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    symId = symbolId('typescript', 'src/api.ts::ApiClient', 'class');
    docId = docSectionId('docs/api.md', '');
    upsertSymbol(db, {
      id: symId, name: 'ApiClient', kind: 'class', location: 'src/api.ts:1',
      signature: contentHash('export class ApiClient {}'), raw_signature: 'export class ApiClient {}',
    });
    vi.clearAllMocks();
    mockDetectGenerator.mockReturnValue('npm run docs:generate');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks the doc synced without a hash refresh when the file vanishes after regeneration', async () => {
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: '', doc_type: 'generated', content_hash: 'h', status: 'stale' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'generates' });
    // Generator "succeeds" but the file is gone when re-read.
    mockUpdateGeneratedDoc.mockReturnValue({ success: true, output: 'ok' });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toContain('docs/api.md');
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
    expect(getDocSection(db, docId)!.content_hash).toBe('h'); // unchanged
  });

  it('treats a doc path that became a directory as unreadable (no hash refresh)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'api.md'), { recursive: true });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: '', doc_type: 'generated', content_hash: 'h', status: 'stale' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'generates' });
    mockUpdateGeneratedDoc.mockReturnValue({ success: true, output: 'ok' });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toContain('docs/api.md');
    expect(getDocSection(db, docId)!.content_hash).toBe('h');
  });

  it('reports when the synced mark fails after a vanished-file regeneration', async () => {
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: '', doc_type: 'generated', content_hash: 'h', status: 'stale' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'generates' });
    mockUpdateGeneratedDoc.mockReturnValue({ success: true, output: 'ok' });

    const result = await syncSymbol(proxyDb(db, "SET status = 'in_sync'"), autoConfig, symId, tmpDir);

    expect(result.errors.some((e) => e.includes('Failed to mark generated doc') && e.includes('as synced'))).toBe(true);
    expect(result.docsUpdated).toHaveLength(0);
  });

  it('reports when the hash refresh fails after a successful regeneration', async () => {
    const docPath = path.join(tmpDir, 'docs', 'api.md');
    fs.writeFileSync(docPath, '# API\n\nRegenerated.\n', 'utf-8');
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: '', doc_type: 'generated', content_hash: 'old', status: 'stale' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'generates' });
    mockUpdateGeneratedDoc.mockReturnValue({ success: true, output: 'ok' });

    const result = await syncSymbol(proxyDb(db, 'SET content_hash'), autoConfig, symId, tmpDir);

    expect(result.errors.some((e) => e.includes('Failed to mark generated doc') && e.includes('as synced'))).toBe(true);
    expect(result.docsUpdated).toHaveLength(0);
  });

  it('rejects an absolute doc path outside the project without touching anything', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-outside-gen-'));
    upsertDocSection(db, {
      id: docId, file: path.join(outside, 'api.md'), anchor: '',
      doc_type: 'generated', content_hash: 'h', status: 'stale',
    });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'generates' });
    mockUpdateGeneratedDoc.mockReturnValue({ success: true, output: 'ok' });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.errors).toHaveLength(0); // marked synced, but nothing read/written outside
    expect(fs.existsSync(path.join(outside, 'api.md'))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
