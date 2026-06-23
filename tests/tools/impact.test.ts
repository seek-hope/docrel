// tests/tools/impact.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { docrelImpact, formatImpactMarkdown } from '../../src/tools/impact.js';
import { docrelLink } from '../../src/tools/link.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds affected docs when a linked symbol file changes', async () => {
    const symId = symbolId('ts', 'src/auth.ts::login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');

    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const impact = await docrelImpact(db, ['src/auth.ts']);
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
    closeAllDbs();
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

describe('formatImpactMarkdown', () => {
  it('outputs markdown with changed files section', () => {
    const report = {
      changedFiles: ['src/auth.ts'],
      affectedSymbols: [],
      affectedDocs: [],
      errors: [],
    };
    const md = formatImpactMarkdown(report);
    expect(md).toContain('## DocRel Impact Analysis');
    expect(md).toContain('### Changed Files (1)');
    expect(md).toContain('`src/auth.ts`');
  });

  it('outputs affected symbols with details', () => {
    const report = {
      changedFiles: ['src/auth.ts'],
      affectedSymbols: [
        { id: 's1', name: 'login', kind: 'function', location: 'src/auth.ts:42' },
      ],
      affectedDocs: [],
      errors: [],
    };
    const md = formatImpactMarkdown(report);
    expect(md).toContain('### Affected Symbols (1)');
    expect(md).toContain('`login` (function)');
  });

  it('outputs affected docs with status', () => {
    const report = {
      changedFiles: ['src/auth.ts'],
      affectedSymbols: [],
      affectedDocs: [
        { id: 'd1', file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone', status: 'stale', relationship: 'describes' },
      ],
      errors: [],
    };
    const md = formatImpactMarkdown(report);
    expect(md).toContain('### Affected Documentation (1)');
    expect(md).toContain('`docs/api.md#auth`');
    expect(md).toContain('**stale** (describes)');
  });

  it('shows empty states gracefully', () => {
    const report = {
      changedFiles: [],
      affectedSymbols: [],
      affectedDocs: [],
      errors: [],
    };
    const md = formatImpactMarkdown(report);
    expect(md).toContain('_(none)_');
  });

  it('shows errors section when present', () => {
    const report = {
      changedFiles: ['bad.ts'],
      affectedSymbols: [],
      affectedDocs: [],
      errors: [{ file: 'bad.ts', message: 'Permission denied' }],
    };
    const md = formatImpactMarkdown(report);
    expect(md).toContain('### Errors (1)');
    expect(md).toContain('Permission denied');
  });
});
