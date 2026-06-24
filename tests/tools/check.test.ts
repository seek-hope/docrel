import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertDocSection, markDocStale } from '../../src/db/docs.js';
import { docsyncCheck, formatCheckMarkdown, formatCheckCI } from '../../src/tools/check.js';
import { docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('docsyncCheck', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsync-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes when no stale docs', () => {
    const report = docsyncCheck(db, true);
    expect(report.passed).toBe(true);
  });

  it('fails when there are stale docs in strict mode', () => {
    const docId = docSectionId('docs/api.md', 'auth');
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    markDocStale(db, docId);

    const report = docsyncCheck(db, true);
    expect(report.passed).toBe(false);
    expect(report.staleDocs).toHaveLength(1);
  });

  describe('formatCheckMarkdown', () => {
    it('outputs all-clear message when no stale docs', () => {
      const report = { passed: true, staleDocs: [], summary: 'All documentation is in sync.' };
      const md = formatCheckMarkdown(report);
      expect(md).toContain('## DocSync Check');
      expect(md).toContain('All documentation is in sync.');
    });

    it('outputs error message when report has error', () => {
      const report = { passed: false, staleDocs: [], summary: '', error: 'Database error' };
      const md = formatCheckMarkdown(report);
      expect(md).toContain('**Error:** Database error');
    });

    it('lists stale docs with details', () => {
      const report = {
        passed: false,
        staleDocs: [{
          id: 'd1',
          file: 'docs/api.md',
          anchor: 'auth',
          doc_type: 'standalone',
          status: 'stale',
          linkedSymbols: ['sym1', 'sym2'],
        }],
        summary: '1 stale',
      };
      const md = formatCheckMarkdown(report);
      expect(md).toContain('### docs/api.md#auth');
      expect(md).toContain('**Status:** stale');
      expect(md).toContain('**Linked symbols:** sym1, sym2');
    });

    it('handles empty anchor gracefully', () => {
      const report = {
        passed: false,
        staleDocs: [{
          id: 'd1',
          file: 'README.md',
          anchor: '',
          doc_type: 'standalone',
          status: 'stale',
          linkedSymbols: [],
        }],
        summary: '1 stale',
      };
      const md = formatCheckMarkdown(report);
      expect(md).toContain('### README.md');
      expect(md).not.toContain('README.md#');
    });
  });

  describe('formatCheckCI', () => {
    it('outputs no annotations when no stale docs', () => {
      const report = { passed: true, staleDocs: [], summary: 'All documentation is in sync.' };
      const ci = formatCheckCI(report);
      expect(ci).not.toContain('::warning');
      expect(ci).not.toContain('::error');
    });

    it('outputs warning annotation for each stale doc', () => {
      const report = {
        passed: true,
        staleDocs: [{
          id: 'd1',
          file: 'docs/api.md',
          anchor: 'auth',
          doc_type: 'standalone',
          status: 'stale',
          linkedSymbols: [],
        }],
        summary: '1 stale',
      };
      const ci = formatCheckCI(report);
      expect(ci).toContain('::warning file=docs/api.md');
      expect(ci).toContain('has stale documentation');
    });

    it('outputs error annotation when passed is false', () => {
      const report = {
        passed: false,
        staleDocs: [{
          id: 'd1',
          file: 'docs/api.md',
          anchor: 'auth',
          doc_type: 'standalone',
          status: 'stale',
          linkedSymbols: [],
        }],
        summary: '1 stale',
      };
      const ci = formatCheckCI(report);
      expect(ci).toContain('::error');
      expect(ci).toContain('Documentation is out of sync with code');
    });

    it('escapes commas in file paths', () => {
      const report = {
        passed: true,
        staleDocs: [{
          id: 'd1',
          file: 'docs/a,b.md',
          anchor: 'intro',
          doc_type: 'standalone',
          status: 'stale',
          linkedSymbols: [],
        }],
        summary: '1 stale',
      };
      const ci = formatCheckCI(report);
      expect(ci).toContain('file=docs/a%2Cb.md');
    });
  });
});
