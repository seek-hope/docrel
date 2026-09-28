// src/cli-support.ts — testable helpers extracted from cli.ts.
// The CLI entry (cli.ts) keeps argv/commander wiring; decision logic with
// real behavior lives here so it can be unit-tested in-process.
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CodegraphClient } from './codegraph/client.js';
import { CodegraphExtractor } from './extractors/codegraph.js';
import { BuiltinExtractor } from './extractors/builtin.js';
import type { SymbolExtractor } from './extractors/interface.js';
import type { DocRelayConfig } from './utils/config.js';
import { scanProject } from './discovery/scanner.js';
import type { ScanReport } from './discovery/scanner.js';
import { shouldFallbackToBuiltin, assessScanCollapse } from './sync/scan-fallback.js';
import { scanDocs } from './discovery/doc-scanner.js';
import { autoLink, ingestDocSections } from './discovery/auto-linker.js';
import { pruneVanishedDocSections } from './db/docs.js';
import { listSymbols } from './db/symbols.js';

/** Safe error message: handles null, undefined, string, and non-Error throws.
 *  Sanitizes absolute filesystem paths to prevent information disclosure. */
export function errMsg(e: unknown, projectRoot: string): string {
  // Non-Error throws stringify to '[object Object]' — treat anything that is
  // not an Error or a string as unknown rather than emitting a useless blob.
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
  // Sanitize project root paths from error messages
  return raw
    .replace(new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<projectRoot>')
    .replace(/\/(?:home|opt|var|etc|tmp|usr)\/[^\s:,)]*/g, '<path>');
}

/** Shared extractor factory — used by ensureContext, scan, and gc.
 *  Tries Codegraph first, falls back to builtin regex extractor.
 *  Diagnostics are handled by CodegraphClient.preflight(), so we stay quiet. */
export async function createExtractor(cg: CodegraphClient, _cfg: DocRelayConfig): Promise<SymbolExtractor> {
  const codegraphExt = new CodegraphExtractor(cg);
  if (await codegraphExt.isAvailable()) return codegraphExt;
  return new BuiltinExtractor();
}

/**
 * Run a scan but fall back to the builtin regex extractor when the chosen
 * extractor (codegraph) returns zero symbols while the code directories do
 * contain source files. The codegraph binary may exist yet produce an
 * unparseable `explore` output, resulting in a silent tool-wide failure;
 * this closes that gap by re-scanning with the builtin extractor.
 * Returns the fallback scan report when a fallback happened.
 */
export async function scanWithFallback(
  extractor: SymbolExtractor,
  cfgDb: Database.Database,
  cfgConfig: DocRelayConfig,
  cfgRoot: string,
  fullScan = true,
): Promise<ScanReport> {
  const report = await scanProject(extractor, cfgDb, cfgConfig, cfgRoot, fullScan);
  if (shouldFallbackToBuiltin(report.totalSymbols, extractor.name, cfgConfig.code_dirs, cfgRoot)) {
    console.warn('DocRelay: codegraph returned 0 symbols, fell back to builtin extractor');
    return scanProject(new BuiltinExtractor(), cfgDb, cfgConfig, cfgRoot, fullScan);
  }
  // Soft counterpart of gc's collapse guard: a full scan that re-discovers
  // only a fraction of the tracked symbols almost always means a stale or
  // broken index, not a mass deletion. Warn early — gc would refuse anyway.
  // Incremental scans legitimately see only changed files, so skip them.
  if (fullScan) {
    const { c: dbCount } = cfgDb.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number };
    const collapse = assessScanCollapse(dbCount, Math.max(0, dbCount - report.scannedIds.length));
    if (collapse.collapsed) {
      console.warn(`DocRelay: scan re-discovered only ${report.scannedIds.length} of ${dbCount} tracked symbols (${collapse.missing} missing). The symbol index may be stale — run \`codegraph sync\` (or check .docrelayignore) before trusting \`doc-relay gc\`; gc's collapse guard would refuse to run on this scan.`);
    }
  }
  return report;
}

/** Check if doc-relay has been initialized in this project. */
export function isProjectInitialized(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.docrelay')) ||
         fs.existsSync(path.join(projectRoot, '.git', 'docrelay.db'));
}

/** Report shape returned by runDocsPipeline (mirrors the scan command output). */
export interface DocsPipelineReport {
  docs: {
    totalFiles: number;
    totalSections: number;
    newDocSections: number;
    newMappings: number;
    failedFiles: string[];
    skippedMissing: string[];
    /** Ghost sections deleted this run: standalone rows whose anchors no
     *  longer appear in a successfully parsed doc file (renamed/deleted
     *  headings). See pruneVanishedDocSections. */
    prunedDocSections: number;
  };
  autoLink: {
    totalMatched: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
  };
}

/**
 * Documentation half of a scan: parse doc dirs, ingest sections, and
 * auto-link symbol↔doc mappings. Shared by `init` (full run) and `scan`
 * (delta-filtered on --incremental) so both entry points produce identical
 * database state — previously init scanned symbols only and docs were never
 * ingested until the first explicit `scan`.
 *
 * Delta contract (incremental runs):
 *   - docs whose mtime predates prevScanAt (minus a 1s filesystem-granularity
 *     tolerance, mirroring the extractor cutoff) are skipped for ingest;
 *   - auto-link evaluates only pairs that can produce something new:
 *     changed symbols × ALL sections, then ALL symbols × changed sections;
 *   - a no-change incremental scan does zero O(N×M) matching work.
 * Pass prevScanAt=undefined for a full run (everything counts as changed).
 */
export async function runDocsPipeline(
  db: Database.Database,
  config: DocRelayConfig,
  projectRoot: string,
  prevScanAt: number | undefined,
  scannedIds: string[],
): Promise<DocsPipelineReport> {
  const { sections, report: docReport } = await scanDocs(config.doc_dirs, projectRoot);

  const changedSections = prevScanAt === undefined
    ? sections
    : sections.filter((section) => {
        try {
          const mtime = fs.statSync(path.join(projectRoot, section.file)).mtimeMs;
          return mtime + 1000 > prevScanAt;
        } catch {
          return true; // stat failure: include (correctness over speed)
        }
      });
  const ingestResult = ingestDocSections(db, changedSections);

  // Ghost-section pruning: remove standalone rows whose anchors vanished from
  // their doc file (renamed/deleted headings). Built from ALL parsed files —
  // not just changedSections — because an unchanged file's anchor set is just
  // as authoritative, and an incremental run must not resurrect ghosts.
  // Files that failed to parse are excluded by scanDocs, so a transient
  // parser failure can never mass-delete sections.
  const parsedAnchors = new Map<string, Set<string>>();
  for (const file of docReport.parsedFiles) parsedAnchors.set(file, new Set());
  for (const section of sections) parsedAnchors.get(section.file)?.add(section.anchor);

  // Deleted doc FILES are a second ghost population: their rows can never be
  // re-parsed, so parsedFiles alone never covers them. Any standalone row
  // whose file lives under a configured doc_dir but no longer exists on disk
  // is pruned with an empty anchor set (= all its rows). Files outside the
  // configured doc_dirs are left alone — removing a dir from the config must
  // not wipe its history; neither must an .docrelayignore'd or failed parse.
  const normalizedDocDirs = config.doc_dirs
    .map((d) => path.normalize(d).replace(/[\\/]+$/, ''))
    .filter((d) => d && d !== '.');
  const isUnderDocDir = (file: string): boolean => {
    const nf = path.normalize(file);
    return normalizedDocDirs.some((d) => nf === d || nf.startsWith(d + path.sep));
  };
  const knownDocFiles = db.prepare(
    "SELECT DISTINCT file FROM doc_sections WHERE doc_type = 'standalone'",
  ).all() as Array<{ file: string }>;
  for (const { file } of knownDocFiles) {
    if (parsedAnchors.has(file) || !isUnderDocDir(file)) continue;
    let exists = false;
    try {
      const resolved = path.resolve(projectRoot, file);
      const root = path.resolve(projectRoot);
      // Containment first: a pathological DB row (../, absolute) must not
      // turn the existence check into a filesystem probe outside the project.
      exists = (resolved === root || resolved.startsWith(root + path.sep)) && fs.existsSync(resolved);
    } catch { /* treated as missing below */ }
    if (!exists) parsedAnchors.set(file, new Set());
  }
  const prunedDocSections = pruneVanishedDocSections(db, parsedAnchors);

  const allSymbols = listSymbols(db);
  const scannedIdSet = new Set(scannedIds);
  const changedSymbols = scannedIdSet.size === allSymbols.length
    ? allSymbols
    : allSymbols.filter((s) => scannedIdSet.has(s.id));
  const linkCounters = { totalMatched: 0, highConfidence: 0, mediumConfidence: 0, lowConfidence: 0 };
  const mergeLinkResult = (r: typeof linkCounters) => {
    linkCounters.totalMatched += r.totalMatched;
    linkCounters.highConfidence += r.highConfidence;
    linkCounters.mediumConfidence += r.mediumConfidence;
    linkCounters.lowConfidence += r.lowConfidence;
  };
  if (changedSymbols.length > 0 && sections.length > 0) {
    mergeLinkResult(autoLink(db, changedSymbols, sections));
  }
  if (changedSections.length > 0 && allSymbols.length > 0) {
    mergeLinkResult(autoLink(db, allSymbols, changedSections));
  }

  return {
    docs: {
      totalFiles: docReport.totalFiles,
      totalSections: docReport.totalSections,
      newDocSections: ingestResult.newDocSections,
      newMappings: ingestResult.newMappings,
      failedFiles: docReport.failedFiles,
      skippedMissing: docReport.skippedMissing,
      prunedDocSections,
    },
    autoLink: linkCounters,
  };
}
