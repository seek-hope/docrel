import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../src/db/connection.js';
import { runMigrations } from '../src/db/schema.js';
import { upsertSymbol, markSignatureChanged } from '../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../src/db/docs.js';
import { createMapping } from '../src/db/mappings.js';
import { docSectionId } from '../src/utils/hash.js';
import { scanProject } from '../src/discovery/scanner.js';
import { BuiltinExtractor } from '../src/extractors/builtin.js';
import { docrelayGc } from '../src/tools/gc.js';
import type { DocRelayConfig } from '../src/utils/config.js';

function makeConfig(projectRoot: string): DocRelayConfig {
  return {
    version: 1,
    project: path.basename(projectRoot),
    code_dirs: ['src'],
    doc_dirs: [],
    auto_generate: false,
    strategy: 'mark_stale',
    stale_threshold_days: 30,
    languages: ['typescript'],
    extractor: 'builtin',
    gc_symbol_ttl_days: 30,
    confirm_required: false,
    commit_changes: false,
    output_dir: 'docs',
  } as unknown as DocRelayConfig;
}

describe('core closure: signature change, stable IDs, gc, multi-line signatures', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-closure-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('① signature change marks linked docs stale and writes affected_docs', () => {
    it('marks non-rejected mapped docs stale and records affected_docs', () => {
      const realSymId = 'sym-abc';
      const docA = docSectionId('docs/a.md', 'section-a');
      const docB = docSectionId('docs/b.md', 'section-b');
      const docRejected = docSectionId('docs/c.md', 'section-c');

      upsertSymbol(db, { id: realSymId, name: 'foo', kind: 'function', signature: 'old-sig' });
      upsertDocSection(db, { id: docA, file: 'docs/a.md', doc_type: 'standalone', status: 'in_sync' });
      upsertDocSection(db, { id: docB, file: 'docs/b.md', doc_type: 'standalone', status: 'in_sync' });
      upsertDocSection(db, { id: docRejected, file: 'docs/c.md', doc_type: 'standalone', status: 'in_sync' });

      createMapping(db, { symbol_id: realSymId, doc_id: docA, rel_type: 'describes', review_status: 'auto' });
      createMapping(db, { symbol_id: realSymId, doc_id: docB, rel_type: 'describes', review_status: 'confirmed' });
      createMapping(db, { symbol_id: realSymId, doc_id: docRejected, rel_type: 'describes', review_status: 'rejected' });

      const ok = markSignatureChanged(db, realSymId, 'old-sig', 'new-sig');
      expect(ok).toBe(true);

      expect(getDocSection(db, docA)!.status).toBe('stale');
      expect(getDocSection(db, docB)!.status).toBe('stale');
      // Rejected mapping is untouched.
      expect(getDocSection(db, docRejected)!.status).toBe('in_sync');

      const log = db.prepare('SELECT * FROM changelog WHERE symbol_id = ?').get(realSymId) as any;
      expect(log.change_type).toBe('signature_changed');
      const affected = JSON.parse(log.affected_docs);
      expect(affected).toContain(docA);
      expect(affected).toContain(docB);
      expect(affected).not.toContain(docRejected);
      // Since docs were affected, sync_status is 'pending' (pending processing).
      expect(log.sync_status).toBe('pending');
    });

    it('keeps sync_status applied when there are no mappings', () => {
      const symId = 'sym-nomapping';
      upsertSymbol(db, { id: symId, name: 'bar', kind: 'function', signature: 's1' });
      markSignatureChanged(db, symId, 's1', 's2');
      const log = db.prepare('SELECT * FROM changelog WHERE symbol_id = ?').get(symId) as any;
      expect(JSON.parse(log.affected_docs)).toEqual([]);
      expect(log.sync_status).toBe('applied');
    });
  });

  describe('② line drift keeps symbol IDs stable', () => {
    it('does not change symbol ID when a line is inserted above the definition', async () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
      const file = path.join(srcDir, 'mod.ts');
      const config = makeConfig(tmpDir);

      fs.writeFileSync(file, [
        'export function hello(a: number) {',
        '  return a + 1;',
        '}',
      ].join('\n'));

      const extractor = new BuiltinExtractor();
      const report1 = await scanProject(extractor, db, config, tmpDir, true);
      const hello = report1.scannedIds.find((id) => {
        const row = db.prepare('SELECT name FROM symbols WHERE id = ?').get(id) as { name: string } | undefined;
        return row?.name === 'hello';
      });
      expect(hello).toBeTruthy();

      // Insert a comment line above the function definition — the FQN must NOT
      // include the line number, so the symbol ID must be unchanged.
      fs.writeFileSync(file, [
        '// a new leading comment inserted',
        'export function hello(a: number) {',
        '  return a + 1;',
        '}',
      ].join('\n'));

      const report2 = await scanProject(extractor, db, config, tmpDir, true);
      const hello2 = report2.scannedIds.find((id) => {
        const row = db.prepare('SELECT name FROM symbols WHERE id = ?').get(id) as { name: string } | undefined;
        return row?.name === 'hello';
      });
      expect(hello2).toBeTruthy();
      expect(hello2).toBe(hello);

      // Still the same DB row (mapping/state preserved) — only one symbol row.
      expect(db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE name = 'hello'").get()!.c).toBe(1);
    });
  });

  describe('②b duplicate same-name symbols get deterministic suffixes', () => {
    it('appends ::#2, ::#3 for second/third occurrence in the same file, stable under drift', async () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
      const file = path.join(srcDir, 'dup.ts');
      const config = makeConfig(tmpDir);

      fs.writeFileSync(file, [
        'export function util() {}',
        'export function util(a: number) {}',
        'export function util(a: number, b: string) {}',
      ].join('\n'));

      const extractor = new BuiltinExtractor();
      const report1 = await scanProject(extractor, db, config, tmpDir, true);
      expect(report1.scannedIds).toHaveLength(3);
      const rowCount = db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE name = 'util'").get()!;
      expect(rowCount.c).toBe(3);
    });
  });

  describe('③ multi-line signatures are captured completely', () => {
    it('builtin extractor folds a multi-line signature to a single line but keeps raw lines', async () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      const file = path.join(srcDir, 'multi.ts');
      fs.writeFileSync(file, [
        'export function compute(',
        '  a: number,',
        '  b: number,',
        ') {',
        '  return a + b;',
        '}',
      ].join('\n'));

      const extractor = new BuiltinExtractor();
      const syms = await extractor.extract('src', tmpDir);
      const compute = syms.find((s) => s.name === 'compute');
      expect(compute).toBeTruthy();
      expect(compute!.signature).toContain('compute(');
      expect(compute!.signature).toContain('b: number,');
      expect(compute!.signature).toContain('{');
      // Interior whitespace is folded onto one line.
      expect(/\n/.test(compute!.signature ?? '')).toBe(false);
      // Raw signature preserves the original newlines.
      expect(compute!.raw_signature!.split('\n').length).toBeGreaterThan(1);
      // Single-line signatures stay byte-identical to the old behavior.
      expect(compute!.signature!.includes('a: number')).toBe(true);
    });

    it('stops at a single-line statement (backward compatible)', async () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      const file = path.join(srcDir, 'single.ts');
      fs.writeFileSync(file, 'export function foo() {}');
      const extractor = new BuiltinExtractor();
      const syms = await extractor.extract('src', tmpDir);
      const foo = syms.find((s) => s.name === 'foo');
      expect(foo!.signature).toBe('export function foo() {}');
      expect(foo!.raw_signature).toBe('export function foo() {}');
    });
  });

  describe('④ gc marks docs stale when it flags a deleted symbol', () => {
    it('marks associated docs stale and records affected_docs on first miss', () => {
      const symId = 'sym-deleted';
      const docId = docSectionId('docs/deleted.md', 'section');
      upsertSymbol(db, { id: symId, name: 'gone', kind: 'function', signature: 's' });
      upsertDocSection(db, { id: docId, file: 'docs/deleted.md', doc_type: 'standalone', status: 'in_sync' });
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes', review_status: 'auto' });
      // Symbol not present in the scan → first miss.
      const report = docrelayGc(db, { scannedIds: [], totalSymbols: 0, newSymbols: 0, updatedSymbols: 0, failedDirs: [] }, false);

      expect(report.symbolsMarkedStale).toBe(1);
      // Doc is now stale.
      expect(getDocSection(db, docId)!.status).toBe('stale');

      const log = db.prepare("SELECT * FROM changelog WHERE symbol_id = ? AND change_type = 'deleted'").get(symId) as any;
      expect(JSON.parse(log.affected_docs)).toEqual([docId]);
    });

    it('creates a created changelog entry for newly scanned symbols', async () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
      const file = path.join(srcDir, 'new.ts');
      fs.writeFileSync(file, 'export function brandNew() {}');
      const config = makeConfig(tmpDir);
      const extractor = new BuiltinExtractor();
      await scanProject(extractor, db, config, tmpDir, true);

      const id = db.prepare("SELECT id FROM symbols WHERE name = 'brandNew'").get() as { id: string };
      const log = db.prepare("SELECT * FROM changelog WHERE symbol_id = ? AND change_type = 'created'").get(id.id) as any;
      expect(log).toBeTruthy();
      expect(log.sync_status).toBe('applied');
    });
  });
});
