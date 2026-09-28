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
