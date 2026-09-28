// tests/tools/impact.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { docrelayImpact, formatImpactMarkdown } from '../../src/tools/impact.js';
import { docrelayLink } from '../../src/tools/link.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('docrelayImpact', () => {
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

  it('finds affected docs when a linked symbol file changes', () => {
    const symId = symbolId('ts', 'src/auth.ts::login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');

    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const impact = docrelayImpact(db, ['src/auth.ts']);
    expect(impact.affectedDocs).toHaveLength(1);
    expect(impact.affectedDocs[0].file).toBe('docs/api.md');
  });

  it('rejects batches larger than 1000 files', () => {
    const files = Array.from({ length: 1001 }, (_, i) => `src/f${i}.ts`);
    const impact = docrelayImpact(db, files, tmpDir);

    expect(impact.affectedSymbols).toHaveLength(0);
    expect(impact.errors).toHaveLength(1);
    expect(impact.errors[0].message).toContain('Too many files: 1001 (max 1000)');
  });

  it('returns a database error when the db is closed before the call', () => {
    closeDb(tmpDir);

    const impact = docrelayImpact(db, ['src/a.ts'], tmpDir);

    expect(impact.errors).toHaveLength(1);
    expect(impact.errors[0].message).toContain('Database error');
  });

  it('reports empty and overlong file paths as errors', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const impact = docrelayImpact(db, ['', '   ', 'x'.repeat(4097)], tmpDir);

    expect(impact.errors).toHaveLength(3);
    expect(impact.errors[0].message).toBe('Empty file path');
    expect(impact.errors[1].message).toBe('Empty file path');
    expect(impact.errors[2].message).toContain('Path exceeds 4096 characters');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping path exceeding'));
  });

  it('skips paths outside the project root', () => {
    const impact = docrelayImpact(db, ['../outside.ts'], tmpDir);

    expect(impact.errors).toHaveLength(1);
    expect(impact.errors[0].message).toContain('Path outside project root');
    expect(impact.affectedSymbols).toHaveLength(0);
  });

  it('does not treat colon-prefixed sibling files as matches', () => {
    // LIKE 'src/foo:%' matches location 'src/foo:bar.ts:5'; the exact
    // file-portion comparison must reject it.
    upsertSymbol(db, { id: symbolId('ts', 'src/foo:bar.ts::login', 'function'), name: 'login', kind: 'function', location: 'src/foo:bar.ts:5' });

    const impact = docrelayImpact(db, ['src/foo'], tmpDir);

    expect(impact.affectedSymbols).toHaveLength(0);
  });

  it('deduplicates symbols and docs across repeated files and shared mappings', () => {
    const symA = symbolId('ts', 'src/a.ts::alpha', 'function');
    const symB = symbolId('ts', 'src/a.ts::beta', 'function');
    const docId = docSectionId('docs/api.md', 'api');
    upsertSymbol(db, { id: symA, name: 'alpha', kind: 'function', location: 'src/a.ts:1' });
    upsertSymbol(db, { id: symB, name: 'beta', kind: 'function', location: 'src/a.ts:2' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'api', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symA, doc_id: docId, rel_type: 'describes' });
    createMapping(db, { symbol_id: symB, doc_id: docId, rel_type: 'describes' });

    const impact = docrelayImpact(db, ['src/a.ts', 'src/a.ts'], tmpDir);

    expect(impact.affectedSymbols).toHaveLength(2);
    expect(impact.affectedDocs).toHaveLength(1);
  });

  it('sanitizes per-file processing errors instead of aborting', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Close the raw handle without going through closeDb so assertDbOpen
    // still passes and the failure lands in the per-file guard.
    db.close();

    const impact = docrelayImpact(db, ['src/a.ts'], tmpDir);

    expect(impact.errors).toHaveLength(1);
    expect(impact.errors[0].message).toContain('not open');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping src/a.ts due to error'));
  });
});

describe('docrelayLink', () => {
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

  it('creates a mapping between symbol and doc', () => {
    const symId = symbolId('ts', 'login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', doc_type: 'standalone' });

    const result = docrelayLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes' });
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
    expect(md).toContain('## DocRelay Impact Analysis');
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
