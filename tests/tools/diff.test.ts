// tests/tools/diff.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatDiffMarkdown, docrelayDiff } from '../../src/tools/diff.js';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('formatDiffMarkdown', () => {
  it('outputs symbol header with signature', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(): void' },
      changeLog: [],
      affectedDocs: [],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('## DocRelay Diff');
    expect(md).toContain('### Symbol: `login`');
    expect(md).toContain('**Signature:** `function login(): void`');
  });

  it('renders change log as markdown table', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(user: string): void' },
      changeLog: [
        {
          timestamp: '2025-01-15T10:00:00Z',
          change_type: 'signature',
          old_sig: 'function login(): void',
          new_sig: 'function login(user: string): void',
          sync_status: 'synced',
        },
      ],
      affectedDocs: [],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('### Change Log (1 entries)');
    expect(md).toContain('| Timestamp | Type | Old Signature | New Signature | Status |');
    expect(md).toContain('| 2025-01-15T10:00:00Z | signature |');
    expect(md).toContain('synced');
  });

  it('shows affected docs', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(): void' },
      changeLog: [],
      affectedDocs: [
        { file: 'docs/api.md', anchor: 'auth', status: 'stale' },
      ],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('### Affected Documentation (1)');
    expect(md).toContain('`docs/api.md#auth` — **stale**');
  });

  it('shows no-change-log message when empty', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(): void' },
      changeLog: [],
      affectedDocs: [],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('_(no change log entries)_');
  });
});

describe('docrelayDiff', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-diff-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns not_found for an unknown symbol', () => {
    const result = docrelayDiff(db, 'no-such-symbol');
    expect(result).toEqual({ found: false, reason: 'not_found', message: 'Symbol not found in database' });
  });

  it('returns the report with changelog entries and affected docs', () => {
    const sym = symbolId('typescript', 'src/a.ts::Login', 'class');
    const docMapped = docSectionId('docs/guide.md', 'Guide');
    upsertSymbol(db, { id: sym, name: 'Login', kind: 'class', location: 'src/a.ts:1', signature: 'class Login' });
    upsertDocSection(db, { id: docMapped, file: 'docs/guide.md', anchor: 'Guide', doc_type: 'standalone', status: 'stale' });
    createMapping(db, { symbol_id: sym, doc_id: docMapped, rel_type: 'describes' });
    // Mapping to a doc that no longer exists exercises the unknown fallbacks.
    // FK enforcement is toggled to allow the dangling reference (doc_sections
    // has ON DELETE CASCADE, so a plain DELETE would remove the mapping too).
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO mappings (symbol_id, doc_id, rel_type) VALUES (?, 'docs/gone.md#Missing', 'references')").run(sym);
    db.pragma('foreign_keys = ON');
    db.prepare(
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig, sync_status) VALUES (?, 'signature_changed', 'class Login {}', 'class Login', 'pending')",
    ).run(sym);

    const result = docrelayDiff(db, sym);

    expect(result.found).toBe(true);
    expect(result.report?.symbol).toEqual({ id: sym, name: 'Login', currentSignature: 'class Login' });
    expect(result.report?.changeLog).toHaveLength(1);
    expect(result.report?.changeLog[0]).toMatchObject({
      change_type: 'signature_changed',
      old_sig: 'class Login {}',
      new_sig: 'class Login',
      sync_status: 'pending',
    });
    expect(result.report?.affectedDocs).toEqual([
      { file: 'docs/guide.md', anchor: 'Guide', status: 'stale' },
      { file: 'unknown', anchor: '', status: 'unknown' },
    ]);
  });

  it('returns db_error when the database is unusable', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.close();

    const result = docrelayDiff(db, 'any');

    expect(result).toEqual({
      found: false,
      reason: 'db_error',
      message: 'Database query error — check server logs for details',
    });
    expect(errSpy).toHaveBeenCalledWith('docrelayDiff failed:', expect.stringContaining('not open'));
  });
});
