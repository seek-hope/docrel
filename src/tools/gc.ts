// src/tools/gc.ts — Symbol garbage collection
import type Database from 'better-sqlite3';
import type { ScanReport } from '../discovery/scanner.js';
import { assertDbOpen } from '../db/connection.js';
import { markDocsStaleForSymbol } from '../db/docs.js';
import { assessScanCollapse } from '../sync/scan-fallback.js';

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '{}';
  }
}

export interface GcReport {
  symbolsRemoved: number;
  symbolsMarkedStale: number;
  dryRun: boolean;
  /** Set when the GC transaction failed — callers should check this. */
  error?: string;
  /** Set when the scan-collapse guard refused to run. No mutations were
   *  made; the message explains how to recover (re-scan, or --force). */
  refused?: string;
}

export interface GcOptions {
  /** Override the scan-collapse guard. Use only when a mass deletion of
   *  source files was intentional. */
  force?: boolean;
}

const STALE_MARKER = '__stale__';

/**
 * Run garbage collection after a scan. Symbols in the database that were not
 * found in the current scan are tracked via the changelog table with a two-pass
 * policy:
 *
 * - First miss: inserts a changelog entry with `change_type = 'deleted'` and
 *   `old_sig = '__stale__'` to mark the symbol as "possibly deleted".
 * - Second consecutive miss: deletes the symbol (cascading to mappings and
 *   changelog entries via foreign key).
 *
 * Pass `dryRun: true` to preview without making changes.
 */
export function docrelayGc(
  db: Database.Database,
  scanReport: ScanReport,
  dryRun: boolean = false,
  opts?: GcOptions,
): GcReport {
  assertDbOpen(db);

  const scannedSet = new Set(scanReport.scannedIds);

  // Get all symbol IDs currently in the database
  const allSymbolIds = db.prepare('SELECT id FROM symbols').all() as Array<{ id: string }>;

  // Scan-collapse guard: when the scan failed to re-discover most of the
  // tracked symbols, the extractor almost certainly saw a broken/stale view
  // of the repo (e.g. a partial codegraph index) — NOT a mass deletion.
  // Running the two-pass policy on such a scan would mark healthy symbols
  // stale and delete them on the next pass. Refuse unless --force was given.
  // This applies to dry runs too: reporting "would mark N stale" for a
  // collapsed scan trains users to trust meaningless numbers.
  let missing = 0;
  for (const { id } of allSymbolIds) {
    if (!scannedSet.has(id)) missing++;
  }
  const collapse = assessScanCollapse(allSymbolIds.length, missing);
  if (!opts?.force && collapse.collapsed) {
    const pct = Math.round((missing / allSymbolIds.length) * 100);
    const found = allSymbolIds.length - missing;
    return {
      symbolsRemoved: 0,
      symbolsMarkedStale: 0,
      dryRun,
      refused: `scan re-discovered only ${found} of ${allSymbolIds.length} tracked symbols (${missing} missing, ${pct}%). GC would treat healthy symbols as deleted. Re-run \`doc-relay scan\` first (or \`codegraph sync\` when using codegraph), then retry — or pass --force if this mass deletion was intentional.`,
    };
  }

  let symbolsRemoved = 0;
  let symbolsMarkedStale = 0;

  if (dryRun) {
    // Count without mutating — query changelog for each missing symbol to
    // determine whether it would be removed or marked stale.
    const staleCheckStmt = db.prepare(
      "SELECT id FROM changelog WHERE symbol_id = ? AND change_type = 'deleted' AND old_sig = ?"
    );
    for (const { id } of allSymbolIds) {
      if (scannedSet.has(id)) continue;
      const prevStale = staleCheckStmt.get(id, STALE_MARKER) as { id: number } | undefined;
      if (prevStale) {
        symbolsRemoved++;
      } else {
        symbolsMarkedStale++;
      }
    }
  } else {
    // Wrap mutations in a transaction for atomicity.
    const deleteStmt = db.prepare('DELETE FROM symbols WHERE id = ?');
    const insertChangelogStmt = db.prepare(
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig, affected_docs, sync_status) VALUES (?, 'deleted', ?, ?, ?, 'pending')"
    );
    const staleCheckStmt = db.prepare(
      "SELECT id FROM changelog WHERE symbol_id = ? AND change_type = 'deleted' AND old_sig = ?"
    );

    try {
      db.transaction(() => {
        for (const { id } of allSymbolIds) {
          if (scannedSet.has(id)) continue;

          const prevStale = staleCheckStmt.get(id, STALE_MARKER) as { id: number } | undefined;

          if (prevStale) {
            // Second consecutive miss — delete the symbol.
            // ON DELETE CASCADE cleans up mappings and changelog entries.
            deleteStmt.run(id);
            symbolsRemoved++;
          } else {
            // First miss — mark as stale via a changelog entry AND also mark
            // associated (non-rejected) docs stale so a deleted symbol's docs
            // don't remain in_sync. The affected doc ids are recorded in the
            // changelog entry's affected_docs.
            const affected = markDocsStaleForSymbol(db, id);
            insertChangelogStmt.run(id, STALE_MARKER, STALE_MARKER, safeStringify(affected));
            symbolsMarkedStale++;
          }
        }
      })();
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('DocRelay: GC transaction failed:', msg);
      // The transaction is atomic — on failure no changes were committed.
      // Return zero mutations WITH an error field so callers (cli.ts gc command)
      // can distinguish "nothing to GC" from "GC failed".
      return { symbolsRemoved: 0, symbolsMarkedStale: 0, dryRun: false, error: msg };
    }
  }

  return { symbolsRemoved, symbolsMarkedStale, dryRun };
}
