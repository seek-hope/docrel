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
import { shouldFallbackToBuiltin } from './sync/scan-fallback.js';
import { scanDocs } from './discovery/doc-scanner.js';
import { autoLink, ingestDocSections } from './discovery/auto-linker.js';
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
export async function createExtractor(cg: CodegraphClient, cfg: DocRelayConfig): Promise<SymbolExtractor> {
  const codegraphExt = new CodegraphExtractor(cg, cfg.codegraph?.maxFiles);
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
    console.warn('codegraph returned 0 symbols, fell back to builtin extractor');
    return scanProject(new BuiltinExtractor(), cfgDb, cfgConfig, cfgRoot, fullScan);
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
    },
    autoLink: linkCounters,
  };
}
