import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { errMsg, createExtractor, scanWithFallback, isProjectInitialized, runDocsPipeline } from '../src/cli-support.js';
import { getDb, closeAllDbs } from '../src/db/connection.js';
import { runMigrations } from '../src/db/schema.js';
import { upsertSymbol } from '../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../src/db/docs.js';
import { symbolId, docSectionId } from '../src/utils/hash.js';
import { BuiltinExtractor } from '../src/extractors/builtin.js';
import type { SymbolExtractor } from '../src/extractors/interface.js';
import type { CodegraphClient } from '../src/codegraph/client.js';
import type { DocRelayConfig } from '../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const config: DocRelayConfig = {
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

describe('errMsg', () => {
  const root = '/home/user/project';

  it('extracts messages from Errors and redacts the project root', () => {
    expect(errMsg(new Error(`failed in ${root}/src/file.ts`), root)).toBe('failed in <projectRoot>/src/file.ts');
  });

  it('redacts common absolute path prefixes', () => {
    expect(errMsg(new Error('cannot read /etc/secrets/key.pem now'), root))
      .toBe('cannot read <path> now');
    expect(errMsg(new Error('bad /tmp/build-output.js'), root)).toBe('bad <path>');
  });

  it('passes strings through and maps unknown shapes to a placeholder', () => {
    expect(errMsg('plain failure', root)).toBe('plain failure');
    expect(errMsg({ code: 42 }, root)).toBe('unknown error');
    expect(errMsg(null, root)).toBe('unknown error');
    expect(errMsg(undefined, root)).toBe('unknown error');
  });
});

describe('createExtractor', () => {
  it('returns the codegraph extractor when available, builtin otherwise', async () => {
    const available = { isAvailable: vi.fn().mockResolvedValue(true) } as unknown as CodegraphClient;
    const ext1 = await createExtractor(available, config);
    expect(ext1.name).toBe('codegraph');

    const unavailable = { isAvailable: vi.fn().mockResolvedValue(false) } as unknown as CodegraphClient;
    const ext2 = await createExtractor(unavailable, config);
    expect(ext2.name).toBe('builtin');
  });
});

describe('isProjectInitialized', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-init-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is false with neither marker, true with .docrelay/ or .git/docrelay.db', () => {
    expect(isProjectInitialized(tmpDir)).toBe(false);

    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    expect(isProjectInitialized(tmpDir)).toBe(false); // .git without the DB is not enough
    fs.writeFileSync(path.join(tmpDir, '.git', 'docrelay.db'), '', 'utf-8');
    expect(isProjectInitialized(tmpDir)).toBe(true);
    fs.rmSync(path.join(tmpDir, '.git'), { recursive: true });

    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    expect(isProjectInitialized(tmpDir)).toBe(true);
  });
});

describe('scanWithFallback', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-fallback-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'a.ts'),
      'export function alpha(): number { return 1; }\n',
      'utf-8',
    );
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const zeroExtractor: SymbolExtractor = {
    name: 'codegraph',
    extract: vi.fn().mockResolvedValue([]),
    isAvailable: vi.fn().mockResolvedValue(true),
  };

  it('falls back to the builtin extractor when codegraph finds 0 symbols in a non-empty dir', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const report = await scanWithFallback(zeroExtractor, db, config, tmpDir);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fell back to builtin'));
    expect(report.totalSymbols).toBeGreaterThanOrEqual(1); // builtin found alpha()
  });

  it('does not fall back when the extractor finds symbols', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await scanWithFallback(new BuiltinExtractor(), db, config, tmpDir);

    expect(report.totalSymbols).toBeGreaterThanOrEqual(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('runDocsPipeline', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const ALPHA = symbolId('typescript', 'src/alpha.ts::alpha', 'function');
  const BETA = symbolId('typescript', 'src/beta.ts::beta', 'function');
  const GAMMA = symbolId('typescript', 'src/gamma.ts::gamma', 'function');
  const ALL_IDS = [ALPHA, BETA, GAMMA];

  // alpha/beta appear as backtick code refs (linked by ingestDocSections);
  // gamma appears ONLY in a heading, so it is linked by autoLink's pass-1
  // heading match — that is what makes autoLink.totalMatched non-zero.
  const DOC = [
    '# Alpha Guide',
    '',
    'The `alpha()` function does things.',
    '',
    '## Beta Notes',
    '',
    'See `beta()` for details.',
    '',
    '## Gamma Notes',
    '',
    'Gamma behavior is described in prose without code references.',
    '',
  ].join('\n');

  const docPath = () => path.join(tmpDir, 'docs', 'guide.md');
  const writeDoc = (body: string = DOC) => fs.writeFileSync(docPath(), body, 'utf-8');
  const seedSymbols = () => {
    upsertSymbol(db, { id: ALPHA, name: 'alpha', kind: 'function', location: 'src/alpha.ts' });
    upsertSymbol(db, { id: BETA, name: 'beta', kind: 'function', location: 'src/beta.ts' });
    upsertSymbol(db, { id: GAMMA, name: 'gamma', kind: 'function', location: 'src/gamma.ts' });
  };
  const mappingCount = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM mappings').get() as { n: number }).n;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-pipeline-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full run ingests doc sections and auto-links backtick references', async () => {
    writeDoc();
    seedSymbols();

    const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    expect(report.docs.totalFiles).toBe(1);
    expect(report.docs.totalSections).toBeGreaterThanOrEqual(2);
    expect(report.docs.newDocSections).toBe(report.docs.totalSections);
    expect(report.autoLink.totalMatched).toBeGreaterThanOrEqual(1);
    expect(mappingCount()).toBeGreaterThanOrEqual(1);
  });

  it('no-change incremental skips ingest and performs zero linking work', async () => {
    writeDoc();
    seedSymbols();
    await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    // Age the doc past the 1s mtime tolerance so the delta filter excludes it.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(docPath(), past, past);

    const report = await runDocsPipeline(db, config, tmpDir, Date.now(), ALL_IDS);

    expect(report.docs.newDocSections).toBe(0);
    expect(report.autoLink).toEqual({
      totalMatched: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
    });
  });

  it('re-ingests changed docs and links new sections against all symbols', async () => {
    writeDoc('# Alpha Guide\n\nThe `alpha()` function does things.\n');
    seedSymbols();
    const first = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);
    expect(first.docs.newDocSections).toBe(1);

    // Add sections (one heading-only gamma reference); the doc mtime is "now",
    // so a prevScanAt a few seconds back classifies it as changed.
    writeDoc(DOC);
    const report = await runDocsPipeline(db, config, tmpDir, Date.now() - 10_000, ALL_IDS);

    expect(report.docs.newDocSections).toBe(2); // Beta Notes + Gamma Notes
    expect(report.autoLink.totalMatched).toBeGreaterThanOrEqual(1);
  });

  it('prunes ghost sections whose headings vanished, cascading their mappings', async () => {
    writeDoc();
    seedSymbols();
    await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);
    const ghostId = docSectionId('docs/guide.md', 'Beta Notes');
    expect(getDocSection(db, ghostId)).toBeDefined();
    const ghostMappings = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM mappings WHERE doc_id = ?').get(ghostId) as { n: number }).n;
    expect(ghostMappings()).toBeGreaterThanOrEqual(1); // `beta()` backtick ref

    // Rename the heading — the 'Beta Notes' row becomes a ghost.
    writeDoc(DOC.replace('## Beta Notes', '## Beta Guide'));
    const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    expect(report.docs.prunedDocSections).toBe(1);
    expect(getDocSection(db, ghostId)).toBeUndefined();
    expect(ghostMappings()).toBe(0); // cascaded via the foreign key
    // The renamed heading was ingested as a new section; siblings survived.
    expect(getDocSection(db, docSectionId('docs/guide.md', 'Beta Guide'))).toBeDefined();
    expect(getDocSection(db, docSectionId('docs/guide.md', 'Alpha Guide'))).toBeDefined();
  });

  it('keeps rows for files that fail to parse — a transient error must not mass-delete', async () => {
    writeDoc();
    seedSymbols();
    await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    fs.chmodSync(docPath(), 0o000);
    try {
      const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);
      expect(report.docs.failedFiles).toContain('docs/guide.md');
      expect(report.docs.prunedDocSections).toBe(0);
      expect(getDocSection(db, docSectionId('docs/guide.md', 'Alpha Guide'))).toBeDefined();
    } finally {
      fs.chmodSync(docPath(), 0o644);
    }
  });

  it('never prunes inline or generated rows — only standalone', async () => {
    writeDoc();
    seedSymbols();
    await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);
    const genId = docSectionId('docs/guide.md', 'Generated Ghost');
    upsertDocSection(db, { id: genId, file: 'docs/guide.md', anchor: 'Generated Ghost', doc_type: 'generated' });
    const inlineId = docSectionId('docs/guide.md', 'Inline Ghost');
    upsertDocSection(db, { id: inlineId, file: 'docs/guide.md', anchor: 'Inline Ghost', doc_type: 'inline' });

    const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    expect(report.docs.prunedDocSections).toBe(0);
    expect(getDocSection(db, genId)).toBeDefined();
    expect(getDocSection(db, inlineId)).toBeDefined();
  });

  it('prunes ALL standalone rows of a doc that was emptied of sections', async () => {
    writeDoc();
    seedSymbols();
    await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);
    expect(mappingCount()).toBeGreaterThanOrEqual(1);

    // An empty file parses successfully to zero sections — its old rows are ghosts.
    writeDoc('');
    const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    expect(report.docs.prunedDocSections).toBe(3); // Alpha Guide, Beta Notes, Gamma Notes
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM doc_sections WHERE file = 'docs/guide.md'").get() as { n: number }).n,
    ).toBe(0);
    expect(mappingCount()).toBe(0);
  });

  it('prunes rows for doc FILES deleted from disk when under a configured doc_dir', async () => {
    writeDoc();
    seedSymbols();
    await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);
    expect(getDocSection(db, docSectionId('docs/guide.md', 'Alpha Guide'))).toBeDefined();

    fs.rmSync(docPath());
    const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    expect(report.docs.prunedDocSections).toBe(3);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM doc_sections WHERE file = 'docs/guide.md'").get() as { n: number }).n,
    ).toBe(0);
  });

  it('keeps rows for deleted files OUTSIDE the configured doc_dirs', async () => {
    writeDoc();
    seedSymbols();
    await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);
    // A section tracked back when 'legacy/' was still a configured doc dir —
    // removing a dir from the config must not wipe its rows.
    upsertDocSection(db, {
      id: docSectionId('legacy/old.md', 'Legacy'),
      file: 'legacy/old.md',
      anchor: 'Legacy',
      doc_type: 'standalone',
    });
    fs.rmSync(docPath());

    const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    expect(report.docs.prunedDocSections).toBe(3); // guide.md's rows only
    expect(getDocSection(db, docSectionId('legacy/old.md', 'Legacy'))).toBeDefined();
  });

  it('limits pass-1 linking to the changed-symbol subset on incremental scans', async () => {
    writeDoc();
    seedSymbols();

    // Only alpha was (re)scanned — beta stays out of the pass-1 symbol set.
    const report = await runDocsPipeline(db, config, tmpDir, undefined, [ALPHA]);

    expect(report.autoLink.totalMatched).toBeGreaterThanOrEqual(1);
    const linked = db
      .prepare('SELECT DISTINCT symbol_id FROM mappings')
      .all() as Array<{ symbol_id: string }>;
    expect(linked.map((r) => r.symbol_id)).toContain(ALPHA);
  });

  it('treats sections as changed when their file stat fails', async () => {
    writeDoc();
    seedSymbols();

    // The pipeline filter is the only statSync caller seeing the .md path
    // (scanDocs walks with Dirent and stats the directory, not the file).
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).endsWith('guide.md')) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return real(p, ...rest as []);
    }) as typeof fs.statSync);

    const report = await runDocsPipeline(db, config, tmpDir, Date.now(), ALL_IDS);

    // Stat failure → included (correctness over speed): sections ingest even
    // though the doc would be "unchanged" by mtime.
    expect(report.docs.newDocSections).toBeGreaterThanOrEqual(3);
  });

  it('reports zeroes and skippedMissing when the docs directory is absent', async () => {
    fs.rmSync(path.join(tmpDir, 'docs'), { recursive: true });
    seedSymbols();

    const report = await runDocsPipeline(db, config, tmpDir, undefined, ALL_IDS);

    expect(report.docs.totalFiles).toBe(0);
    expect(report.docs.newDocSections).toBe(0);
    expect(report.docs.skippedMissing).toContain('docs');
    expect(report.autoLink.totalMatched).toBe(0);
  });

  it('links nothing when the project has no symbols', async () => {
    writeDoc();

    const report = await runDocsPipeline(db, config, tmpDir, undefined, []);

    expect(report.docs.newDocSections).toBeGreaterThanOrEqual(3);
    expect(report.autoLink.totalMatched).toBe(0);
    expect(mappingCount()).toBe(0);
  });

});
