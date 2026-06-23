import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';

export interface CheckReport {
  passed: boolean;
  staleDocs: Array<{
    id: string;
    file: string;
    anchor: string;
    doc_type: string;
    status: string;
    linkedSymbols: string[];
  }>;
  summary: string;
  error?: string;
}

export function docrelCheck(db: Database.Database, strict = false): CheckReport {
  try {
    assertDbOpen(db);
    const staleRows = db.prepare(`
      SELECT d.id, d.file, d.anchor, d.doc_type, d.status, m.symbol_id
      FROM doc_sections d
      LEFT JOIN mappings m ON m.doc_id = d.id
      WHERE d.status = 'stale'
      ORDER BY d.id
    `).all() as Array<{ id: string; file: string; anchor: string; doc_type: string; status: string; symbol_id: string | null }>;

    // Group by doc_id to collect linked symbols per doc
    const docMap = new Map<string, {
      id: string; file: string; anchor: string; doc_type: string; status: string; linkedSymbols: string[];
    }>();
    for (const row of staleRows) {
      let entry = docMap.get(row.id);
      if (!entry) {
        entry = { id: row.id, file: row.file, anchor: row.anchor, doc_type: row.doc_type, status: row.status, linkedSymbols: [] };
        docMap.set(row.id, entry);
      }
      if (row.symbol_id) {
        entry.linkedSymbols.push(row.symbol_id);
      }
    }
    const staleDocs = [...docMap.values()];

    const passed = strict ? staleDocs.length === 0 : true;

    let summary: string;
    if (staleDocs.length === 0) {
      summary = 'All documentation is in sync.';
    } else {
      const uniqueFiles = [...new Set(staleDocs.map((d) => d.file))];
      summary = `${staleDocs.length} doc section(s) are stale across ${uniqueFiles.length} file(s): ${uniqueFiles.join(', ')}`;
    }

    return { passed, staleDocs, summary };
  } catch (err: any) {
    console.error('docrelCheck failed:', err);
    // Database errors always indicate the check could not run — the result
    // is not trustworthy regardless of strict mode. Return passed: false
    // with a sanitized error message to prevent information disclosure.
    return {
      passed: false,
      staleDocs: [],
      summary: `Database error: check server logs for details.`,
      error: 'Database query error — check server logs for details',
    };
  }
}
