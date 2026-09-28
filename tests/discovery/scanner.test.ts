/**
 * scanProject branch coverage with a fake extractor: malformed-symbol
 * isolation, duplicate guards, ignore handling, kind mapping, dir failure
 * sanitization, and the per-dir symbol cap. Complements the real-extractor
 * coverage in tests/inline-scan.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { scanProject, parseLastScanAt } from '../../src/discovery/scanner.js';
import type { SymbolExtractor, ExtractedSymbol } from '../../src/extractors/interface.js';
import type { DocRelayConfig } from '../../src/utils/config.js';

function fakeExtractor(symbols: ExtractedSymbol[]): SymbolExtractor {
  return {
    name: 'fake',
    extract: vi.fn(async () => symbols),
    isAvailable: vi.fn(async () => true),
  };
}

function makeConfig(codeDirs: string[] = ['src']): DocRelayConfig {
  return {
    version: 1,
    project: 'test',
    doc_dirs: [],
    code_dirs: codeDirs,
    strategies: { inline: 'auto_update', standalone: 'mark_stale', generated: 'mark_stale', architecture: 'mark_stale' },
  };
}

function sym(over: Partial<ExtractedSymbol> = {}): ExtractedSymbol {
  return {
    name: 'foo', kind: 'function', file: 'src/a.ts', line: 1,
    signature: 'function foo(): void', language: 'typescript',
    ...over,
  };
}

describe('scanProject — branch coverage', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-scan-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns and returns an empty report when no code_dirs are configured', async () => {
    const report = await scanProject(fakeExtractor([]), db, makeConfig([]), tmpDir);
    expect(report).toMatchObject({ totalSymbols: 0, newSymbols: 0, scannedIds: [] });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No code directories configured'));
  });

  it('skips a malformed symbol (null file) without aborting the directory scan', async () => {
    // Before the fix, isIgnored(sym.file) ran outside the per-symbol guard
    // and a null file killed the entire directory scan.
    const bad = sym({ file: null as never, name: 'broken' });
    const good = sym({ name: 'good' });
    const report = await scanProject(fakeExtractor([bad, good]), db, makeConfig(), tmpDir);

    expect(report.newSymbols).toBe(1);
    const names = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(names.map((r) => r.name)).toEqual(['good']);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('skipping malformed symbol'));
  });

  it('skips symbols whose file matches .docrelayignore', async () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'src/generated.ts\n', 'utf-8');
    const report = await scanProject(
      fakeExtractor([sym({ name: 'gen', file: 'src/generated.ts' }), sym({ name: 'kept' })]),
      db, makeConfig(), tmpDir,
    );
    expect(report.newSymbols).toBe(1);
  });

  it('skips exact duplicates (same file::name, same signature) from overlapping extractor output', async () => {
    const dup = sym({ name: 'dup' });
    const report = await scanProject(fakeExtractor([dup, { ...dup }]), db, makeConfig(), tmpDir);
    expect(report.newSymbols).toBe(1);
    expect(report.scannedIds).toHaveLength(1);
  });

  it('skips the unsigned variant when a signed variant of the same symbol exists', async () => {
    const signed = sym({ name: 'over', signature: 'function over(a: string): void' });
    const unsigned = sym({ name: 'over', signature: undefined });
    const report = await scanProject(fakeExtractor([signed, unsigned]), db, makeConfig(), tmpDir);
    expect(report.scannedIds).toHaveLength(1);
  });

  it('disambiguates same-named symbols with different signatures via ::#2 suffix', async () => {
    const a = sym({ name: 'multi', signature: 'function multi(a: string): void' });
    const b = sym({ name: 'multi', signature: 'function multi(a: number): void' });
    const report = await scanProject(fakeExtractor([a, b]), db, makeConfig(), tmpDir);
    expect(report.scannedIds).toHaveLength(2);
    expect(report.newSymbols).toBe(2);
  });

  it('skips symbols that produce an empty ID (null language)', async () => {
    const report = await scanProject(
      fakeExtractor([sym({ language: null as never, name: 'nolang' }), sym({ name: 'ok' })]),
      db, makeConfig(), tmpDir,
    );
    expect(report.newSymbols).toBe(1);
  });

  it("maps an unrecognized kind to 'unknown' with a warning", async () => {
    const report = await scanProject(
      fakeExtractor([sym({ kind: 'wat' as never, name: 'weird' })]),
      db, makeConfig(), tmpDir,
    );
    expect(report.newSymbols).toBe(1);
    const row = db.prepare('SELECT kind FROM symbols').get() as { kind: string };
    expect(row.kind).toBe('unknown');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Unknown symbol kind 'wat'"));
  });

  it('records a failed dir (sanitized) when the extractor throws', async () => {
    const boom: SymbolExtractor = {
      name: 'boom',
      extract: vi.fn(async () => { throw new Error('codegraph exploded at /very/long/absolute/path/that/leaks:42'); }),
      isAvailable: vi.fn(async () => true),
    };
    const report = await scanProject(boom, db, makeConfig(), tmpDir);
    expect(report.failedDirs).toEqual(['src']);
    expect(report.totalSymbols).toBe(0);
    // The warning was emitted with the path portion stripped.
    const warned = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("Failed to scan directory 'src'");
    expect(warned).not.toContain('/very/long/absolute/path/that/leaks');
  });

  it('stops processing a directory after 10000 symbols to prevent memory pressure', async () => {
    const many = Array.from({ length: 10_005 }, (_, i) =>
      sym({ name: `s${i}`, signature: `function s${i}(): void` }));
    const report = await scanProject(fakeExtractor(many), db, makeConfig(), tmpDir);
    expect(report.newSymbols).toBe(10_000);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('exceeded 10000 symbols'));
  }, 30_000);

  it('marks inline docs stale when a still-present symbol loses its docstring', async () => {
    const withDoc = sym({ name: 'documented', docstring: '/** docs */' });
    await scanProject(fakeExtractor([withDoc]), db, makeConfig(), tmpDir);
    const inlineCount = () =>
      (db.prepare("SELECT COUNT(*) AS c FROM doc_sections WHERE doc_type = 'inline' AND status = 'in_sync'").get() as { c: number }).c;
    expect(inlineCount()).toBe(1);

    // Second scan: same symbol, docstring gone.
    await scanProject(fakeExtractor([sym({ name: 'documented' })]), db, makeConfig(), tmpDir);
    expect(inlineCount()).toBe(0);
    const stale = db.prepare("SELECT COUNT(*) AS c FROM doc_sections WHERE doc_type = 'inline' AND status = 'stale'").get() as { c: number };
    expect(stale.c).toBe(1);
  });
});

describe('parseLastScanAt', () => {
  it('parses legacy SQLite datetime as UTC', () => {
    const ms = parseLastScanAt('2026-09-28 10:30:00');
    expect(ms).toBe(Date.parse('2026-09-28T10:30:00Z'));
  });

  it('parses ISO-8601 with timezone', () => {
    const ms = parseLastScanAt('2026-09-28T10:30:00.000Z');
    expect(ms).toBe(Date.parse('2026-09-28T10:30:00.000Z'));
  });

  it('returns undefined for empty or unparseable values', () => {
    expect(parseLastScanAt('')).toBeUndefined();
    expect(parseLastScanAt('   ')).toBeUndefined();
    expect(parseLastScanAt('not a date')).toBeUndefined();
  });
});
