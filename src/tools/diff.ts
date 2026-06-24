// src/tools/diff.ts
import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';
import { getSymbol } from '../db/symbols.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getDocSection } from '../db/docs.js';

export interface DiffReport {
  symbol: {
    id: string;
    name: string;
    currentSignature: string;
  };
  changeLog: Array<{
    timestamp: string;
    change_type: string;
    old_sig: string;
    new_sig: string;
    sync_status: string;
  }>;
  affectedDocs: Array<{
    file: string;
    anchor: string;
    status: string;
  }>;
}

export interface DiffResult {
  found: boolean;
  reason?: 'not_found' | 'db_error';
  message?: string;
  report?: DiffReport;
}

export function docrelayDiff(db: Database.Database, symbolId: string): DiffResult {
  try {
    assertDbOpen(db);
    const symbol = getSymbol(db, symbolId);
    if (!symbol) return { found: false, reason: 'not_found', message: 'Symbol not found in database' };

    const changelog = db.prepare(
      'SELECT * FROM changelog WHERE symbol_id = ? ORDER BY timestamp DESC LIMIT 10',
    ).all(symbolId) as Array<{
      timestamp: string; change_type: string; old_sig: string; new_sig: string; sync_status: string;
    }>;

    const mappings = getMappingsForSymbol(db, symbolId);
    const affectedDocs = mappings.map((m) => {
      const doc = getDocSection(db, m.doc_id);
      return { file: doc?.file ?? 'unknown', anchor: doc?.anchor ?? '', status: doc?.status ?? 'unknown' };
    });

    return {
      found: true,
      report: {
        symbol: { id: symbol.id, name: symbol.name, currentSignature: symbol.signature },
        changeLog: changelog,
        affectedDocs,
      },
    };
  } catch (err: any) {
    console.error('docrelayDiff failed:', err.message);
    return { found: false, reason: 'db_error', message: 'Database query error — check server logs for details' };
  }
}

/**
 * Format a DiffReport as human-readable markdown.
 */
export function formatDiffMarkdown(report: DiffReport): string {
  const lines: string[] = [];

  lines.push('## DocRelay Diff');
  lines.push('');

  // Symbol header
  lines.push(`### Symbol: \`${report.symbol.name}\``);
  lines.push('');
  lines.push(`- **ID:** ${report.symbol.id}`);
  lines.push(`- **Signature:** \`${report.symbol.currentSignature}\``);
  lines.push('');

  // Change log
  if (report.changeLog.length > 0) {
    lines.push(`### Change Log (${report.changeLog.length} entries)`);
    lines.push('');
    lines.push('| Timestamp | Type | Old Signature | New Signature | Status |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of report.changeLog) {
      const oldSig = (entry.old_sig || '_').slice(0, 60);
      const newSig = (entry.new_sig || '_').slice(0, 60);
      lines.push(`| ${entry.timestamp} | ${entry.change_type} | ${oldSig} | ${newSig} | ${entry.sync_status} |`);
    }
    lines.push('');
  } else {
    lines.push('_(no change log entries)_');
    lines.push('');
  }

  // Affected docs
  lines.push(`### Affected Documentation (${report.affectedDocs.length})`);
  lines.push('');
  if (report.affectedDocs.length > 0) {
    for (const d of report.affectedDocs) {
      const anchorLabel = d.anchor ? `#${d.anchor}` : '';
      lines.push(`- \`${d.file}${anchorLabel}\` — **${d.status}**`);
    }
  } else {
    lines.push('_(none)_');
  }
  lines.push('');

  return lines.join('\n');
}
