import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { logInternalError } from '../utils/error-log.js';
import { assertDbOpen } from '../db/connection.js';

/** Watch-mode failure markers surfaced in status output. `failed` is the
 *  last scan failure (cleared by the next successful scan); `crashed` means
 *  the filesystem watcher itself died (cleared when a new watch starts). */
export interface WatchMarkers {
  failed?: { at: string; error: string };
  crashed?: { at: string; eventsProcessed?: number; errorsEncountered?: number };
}

export interface StatusReport {
  totalSymbols: number;
  linkedSymbols: number;
  linkedPercentage: number;
  syncedDocs: number;
  staleDocs: number;
  totalDocs: number;
  syncPercentage: number;
  pendingChanges: number;
  lastScan: string | null;
  watch?: WatchMarkers;
  error?: string;
}

/** Read a watch marker file best-effort: tiny size cap, tolerant JSON parse. */
function readMarker<T>(file: string): T | undefined {
  try {
    const st = fs.statSync(file);
    if (st.size > 4096) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

export function docrelayStatus(db: Database.Database, projectRoot?: string): StatusReport {
  try {
    assertDbOpen(db);
    const report: StatusReport = db.transaction(() => {
      const totalSymbols = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }).c;
      const linkedSymbols = (db.prepare(
        'SELECT COUNT(DISTINCT symbol_id) as c FROM mappings',
      ).get() as { c: number }).c;
      const totalDocs = (db.prepare('SELECT COUNT(*) as c FROM doc_sections').get() as { c: number }).c;
      const syncedDocs = (db.prepare(
        "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'in_sync'",
      ).get() as { c: number }).c;
      const staleDocs = (db.prepare(
        "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'stale'",
      ).get() as { c: number }).c;
      const pendingChanges = (db.prepare(
        "SELECT COUNT(*) as c FROM changelog WHERE sync_status = 'pending'",
      ).get() as { c: number }).c;

      // Query the last scan timestamp from the metadata table.
      // MAX(updated_at) FROM symbols reflects the last time a symbol changed,
      // not the last scan time — unchanged symbols retain old timestamps,
      // so a scan that detects zero changes would show a stale timestamp.
      const lastScanRow = db.prepare(
        "SELECT value as lastScan FROM metadata WHERE key = 'last_scan_at'"
      ).get() as { lastScan: string | null } | undefined;
      const lastScan = lastScanRow?.lastScan ?? null;

      return {
        totalSymbols,
        linkedSymbols,
        linkedPercentage: totalSymbols > 0 ? Math.round((linkedSymbols / totalSymbols) * 100) : 0,
        syncedDocs,
        staleDocs,
        totalDocs,
        syncPercentage: totalDocs > 0 ? Math.round((syncedDocs / totalDocs) * 100) : 0,
        pendingChanges,
        lastScan,
      };
    })();
    // Watch-mode failure markers live on the filesystem, not in the DB, so
    // they are attached outside the transaction. `watch-failed` is cleared
    // by the next successful scan; `watch-crashed` by the next watch start.
    if (projectRoot) {
      const dir = path.join(projectRoot, '.docrelay');
      const failed = readMarker<NonNullable<WatchMarkers['failed']>>(path.join(dir, 'watch-failed'));
      const crashed = readMarker<NonNullable<WatchMarkers['crashed']>>(path.join(dir, 'watch-crashed'));
      if (failed || crashed) {
        report.watch = { ...(failed ? { failed } : {}), ...(crashed ? { crashed } : {}) };
      }
    }
    return report;
  } catch (err: any) {
    logInternalError('docrelayStatus failed', err);
    return {
      totalSymbols: 0, linkedSymbols: 0, linkedPercentage: 0,
      syncedDocs: 0, staleDocs: 0, totalDocs: 0,
      syncPercentage: 0, pendingChanges: 0, lastScan: null,
      error: 'Database query error — check server logs for details',
    };
  }
}
