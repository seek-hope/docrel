// src/tools/gc.ts — Symbol garbage collection
import type Database from 'better-sqlite3';
import type { ScanReport } from '../discovery/scanner.js';
import { assertDbOpen } from '../db/connection.js';

export interface GcReport {
  symbolsRemoved: number;
  symbolsMarkedStale: number;
  dryRun: boolean;
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
export function docrelGc(
  db: Database.Database,
  scanReport: ScanReport,
  dryRun: boolean = false,
): GcReport {
  assertDbOpen(db);

  const scannedSet = new Set(scanReport.scannedIds);

  // Get all symbol IDs currently in the database
  const allSymbolIds = db.prepare('SELECT id FROM symbols').all() as Array<{ id: string }>;

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
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig, affected_docs, sync_status) VALUES (?, 'deleted', ?, ?, '[]', 'pending')"
    );
    const staleCheckStmt = db.prepare(
      "SELECT id FROM changelog WHERE symbol_id = ? AND change_type = 'deleted' AND old_sig = ?"
    );

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
          // First miss — mark as stale via a changelog entry.
          insertChangelogStmt.run(id, STALE_MARKER, STALE_MARKER);
          symbolsMarkedStale++;
        }
      }
    })();
  }

  return { symbolsRemoved, symbolsMarkedStale, dryRun };
}
