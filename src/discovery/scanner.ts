// src/discovery/scanner.ts
import type Database from 'better-sqlite3';
import type { SymbolExtractor } from '../extractors/interface.js';
import type { DocRelConfig } from '../utils/config.js';
import { upsertSymbol, markSignatureChanged } from '../db/symbols.js';
import { symbolId, contentHash } from '../utils/hash.js';
import { assertDbOpen } from '../db/connection.js';
import { isIgnored } from '../utils/ignore.js';

/** Escape :: in FQN components to prevent symbol ID collisions. */
function escFqn(s: string): string {
  return s.replace(/::/g, '%3A%3A');
}

// ── Progress reporter ──────────────────────────────────────────────────────────

/** Log progress to stderr every `interval` percent. Only active when stderr is
 *  a TTY — no noise when piped or redirected. */
function createProgressReporter(total: number, label: string, interval: number = 5) {
  if (!process.stderr.isTTY || total === 0) return () => {};

  let lastReportedPercent = -interval;

  return (current: number) => {
    const pct = Math.round((current / total) * 100);
    // Report when pct crosses the next interval threshold (or at 100%).
    if (pct >= lastReportedPercent + interval || pct >= 100) {
      lastReportedPercent = Math.floor(pct / interval) * interval;
      process.stderr.write(`\r${label}... ${current}/${total} (${pct}%)`);
      if (pct >= 100) process.stderr.write('\n');
    }
  };
}

/** Codegraph symbol kind → canonical DocRel kind mapping (module-level). */
const KIND_MAP: Record<string, ReturnType<typeof mapKind>> = {
  function: 'function', method: 'function', func: 'function',
  class: 'class', struct: 'class',
  module: 'module', namespace: 'module',
  api_endpoint: 'api_endpoint', endpoint: 'api_endpoint', route: 'api_endpoint',
  type: 'type', interface: 'interface',
  variable: 'variable', const: 'variable', let: 'variable',
};

export interface ScanReport {
  totalSymbols: number;
  newSymbols: number;
  updatedSymbols: number;
  failedDirs: string[];
  /** All symbol IDs that were found during this scan. Used by `docrel gc` to
   *  identify symbols that existed in the database but were not re-discovered. */
  scannedIds: string[];
}

export async function scanProject(
  extractor: SymbolExtractor,
  db: Database.Database,
  config: DocRelConfig,
  projectRoot: string,
): Promise<ScanReport> {
  assertDbOpen(db);
  const failedDirs: string[] = [];
  if (config.code_dirs.length === 0) {
    console.warn('Warning: No code directories configured. Set code_dirs in .docrel/config.yaml');
    return { totalSymbols: 0, newSymbols: 0, updatedSymbols: 0, failedDirs, scannedIds: [] };
  }

  let newSymbols = 0;
  let updatedSymbols = 0;
  const scannedIds = new Set<string>();

  for (const codeDir of config.code_dirs) {
    try {
      // Use the pluggable extractor to discover all symbols in each code directory
      const symbols = await extractor.extract(codeDir, projectRoot);

      const MAX_SYMBOLS_PER_DIR = 10000;
      let dirSymbolCount = 0;
      let symIdx = 0;
      const reportProgress = createProgressReporter(symbols.length, `Scanning ${codeDir}`);
      for (const sym of symbols) {
        reportProgress(++symIdx);
        // Skip symbols whose source file matches a .docrelignore pattern
        if (isIgnored(sym.file, projectRoot)) continue;

        // Wrap per-symbol processing in its own try/catch to prevent a single
        // malformed symbol (e.g., undefined fields from a changed codegraph
        // response) from aborting the entire directory's scan.
        try {
          if (++dirSymbolCount > MAX_SYMBOLS_PER_DIR) {
            console.warn(`DocRel: scan of '${codeDir}' exceeded ${MAX_SYMBOLS_PER_DIR} symbols — stopping to prevent memory pressure`);
            break;
          }
          const lang = sym.language;
          // Include line number in the FQN to disambiguate same-named symbols
          // in different scopes within the same file (e.g., method foo in class A
          // and method foo in class B, both in src/index.ts).
          // Escape the :: separator in file and name components to prevent
          // symbol ID collisions when a file path or symbol name contains ::
          // (e.g., C++ namespace-qualified names or Rust turbofish expressions).
          const fqn = `${escFqn(sym.file)}::${sym.line}::${escFqn(sym.name)}`;
          const id = symbolId(lang, fqn, sym.kind);
          // Skip symbols that produce an empty ID (invalid/missing data from codegraph)
          if (!id) continue;
          const sig = contentHash(sym.signature ?? '');
          const rawSig = sym.signature ?? '';

          scannedIds.add(id);

          const existing = db.prepare('SELECT id, signature FROM symbols WHERE id = ?').get(id) as
            | { id: string; signature: string }
            | undefined;

          if (!existing) {
            upsertSymbol(db, {
              id,
              name: sym.name,
              kind: mapKind(sym.kind),
              project: codeDir,
              location: `${sym.file}:${sym.line}`,
              signature: sig,
              raw_signature: rawSig,
            });
            newSymbols++;
          } else if (existing.signature !== sig) {
            upsertSymbol(db, {
              id,
              name: sym.name,
              kind: mapKind(sym.kind),
              project: codeDir,
              location: `${sym.file}:${sym.line}`,
              signature: sig,
              raw_signature: rawSig,
            });
            // Record changelog entry so docrelDiff and the changelog table
            // surface what changed between scans.
            const logged = markSignatureChanged(db, id, existing.signature, sig, rawSig);
            if (logged) {
              updatedSymbols++;
            } else {
              // If markSignatureChanged returned false (0 rows updated), another
              // connection may have deleted the symbol between our SELECT and the
              // UPDATE inside markSignatureChanged. The symbol WAS upserted above
              // with the new signature — wrap the existence check and INSERT in a
              // transaction to close the TOCTOU gap between the SELECT and INSERT.
              const inserted = db.transaction(() => {
                const stillExists = db.prepare('SELECT 1 FROM symbols WHERE id = ?').get(id);
                if (!stillExists) {
                  console.warn(`DocRel: markSignatureChanged failed for ${id} — symbol deleted concurrently, changelog entry not created`);
                  return false;
                }
                db.prepare(
                  "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig) VALUES (?, 'signature_changed', ?, ?)"
                ).run(id, existing.signature, sig);
                return true;
              })();
              if (inserted) {
                updatedSymbols++;
                console.warn(`DocRel: markSignatureChanged returned false for ${id} (race condition?) — changelog entry inserted directly`);
              }
            }
          }
        } catch (e: any) {
          console.warn(`DocRel: skipping malformed symbol in '${codeDir}': ${e?.message ?? e}`);
          // continue to next symbol — individual failures do not abort the directory
        }
      }
    } catch (err: any) {
      const safeName = codeDir.replace(/[\x00-\x1f\x7f]/g, '');
      failedDirs.push(safeName);
      // Sanitize error message — extract only the meaningful part (first 200 chars,
      // with absolute paths stripped) to prevent information disclosure in MCP/CLI
      // responses that include warnings from this scan.
      const rawMsg = err instanceof Error ? err.message : String(err);
      const sanitized = rawMsg.replace(/\/[^\s:,)]{20,}/g, '...').slice(0, 200);
      console.warn(`DocRel: Failed to scan directory '${safeName}': ${sanitized}`);
    }
  }

  // Use scannedIds count instead of COUNT(*) to avoid counting symbols
  // from other projects or prior scans that this scan did not touch.
  // Since the scan loop already upserted new symbols into the database,
  // the subsequent SELECT returns ALL scanned symbols (both old and new).
  // So existingSymbols.size already includes newSymbols — do NOT add it again.
  const existingSymbols = new Set<string>();
  if (scannedIds.size > 0) {
    // Batch IN query to avoid exceeding SQLite's SQLITE_MAX_VARIABLE_NUMBER (default 999)
    const ids = [...scannedIds];
    const BATCH_SIZE = 500;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const existingRows = db.prepare(
        'SELECT id FROM symbols WHERE id IN (' + batch.map(() => '?').join(',') + ')'
      ).all(...batch) as Array<{ id: string }>;
      for (const row of existingRows) existingSymbols.add(row.id);
    }
  }

  // Record the scan timestamp so status reports show when a scan last ran,
  // not when the last symbol change occurred. Unchanged symbols retain their
  // old updated_at, so MAX(updated_at) can be misleading after no-change scans.
  db.prepare(
    "INSERT INTO metadata (key, value, updated_at) VALUES ('last_scan_at', datetime('now'), datetime('now')) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run();

  return { totalSymbols: existingSymbols.size, newSymbols, updatedSymbols, failedDirs, scannedIds: [...scannedIds] };
}

function mapKind(kind: string): 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable' | 'unknown' {
  const mapped = KIND_MAP[kind.toLowerCase()];
  if (!mapped) {
    console.warn(`DocRel: Unknown symbol kind '${kind}' — storing as 'unknown'`);
    return 'unknown';
  }
  return mapped;
}
