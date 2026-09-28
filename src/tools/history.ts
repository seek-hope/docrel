// src/tools/history.ts
import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';
import { listReviewHistory } from '../db/review-history.js';
import type { EnrichedReviewHistoryRow } from '../db/review-history.js';

export interface HistoryResult {
  ok: boolean;
  message?: string;
  entries: EnrichedReviewHistoryRow[];
}

export function docrelayHistory(
  db: Database.Database,
  opts: { limit?: number; symbol_id?: string } = {},
): HistoryResult {
  try {
    assertDbOpen(db);
    return { ok: true, entries: listReviewHistory(db, opts) };
  } catch (err: any) {
    console.error('docrelayHistory failed:', err instanceof Error ? err.message : err);
    return { ok: false, message: 'Database query error — check server logs for details', entries: [] };
  }
}

/**
 * Format review history entries as human-readable markdown.
 */
export function formatHistoryMarkdown(entries: EnrichedReviewHistoryRow[]): string {
  const lines: string[] = [];

  lines.push(`## DocRelay Review History (${entries.length} entries)`);
  lines.push('');

  if (entries.length === 0) {
    lines.push('_(no review decisions recorded yet)_');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| Timestamp | Action | Symbol | Document | Rel | Actor |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const e of entries) {
    const symbol = e.symbol_name ? `${e.symbol_name} (\`${e.symbol_id}\`)` : `\`${e.symbol_id}\``;
    const doc = e.doc_file
      ? `\`${e.doc_file}${e.doc_anchor ? '#' + e.doc_anchor : ''}\``
      : `\`${e.doc_id}\``;
    lines.push(`| ${e.created_at} | ${e.action} | ${symbol} | ${doc} | ${e.rel_type} | ${e.actor} |`);
  }
  lines.push('');

  return lines.join('\n');
}
