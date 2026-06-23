import type Database from 'better-sqlite3';

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
}

export function docrelStatus(db: Database.Database): StatusReport {
  try {
    return db.transaction(() => {
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

      return {
        totalSymbols,
        linkedSymbols,
        linkedPercentage: totalSymbols > 0 ? Math.round((linkedSymbols / totalSymbols) * 100) : 0,
        syncedDocs,
        staleDocs,
        totalDocs,
        syncPercentage: totalDocs > 0 ? Math.round((syncedDocs / totalDocs) * 100) : 100,
        pendingChanges,
        lastScan: null as string | null,
      };
    })();
  } catch (err: any) {
    console.error('docrelStatus failed:', err.message);
    return {
      totalSymbols: 0, linkedSymbols: 0, linkedPercentage: 0,
      syncedDocs: 0, staleDocs: 0, totalDocs: 0,
      syncPercentage: 0, pendingChanges: 0, lastScan: null,
    };
  }
}
