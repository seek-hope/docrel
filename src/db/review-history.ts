import type Database from 'better-sqlite3';

export type ReviewAction = 'confirmed' | 'rejected';

export interface ReviewHistoryRow {
  id: number;
  symbol_id: string;
  doc_id: string;
  rel_type: string;
  action: ReviewAction;
  actor: string;
  created_at: string;
}

/** History row enriched with the current symbol/doc names (null when the
 *  referenced entity was deleted after the review decision was recorded). */
export interface EnrichedReviewHistoryRow extends ReviewHistoryRow {
  symbol_name: string | null;
  doc_file: string | null;
  doc_anchor: string | null;
}

export interface RecordReviewActionInput {
  symbol_id: string;
  doc_id: string;
  rel_type: string;
  action: ReviewAction;
  actor?: string;
}

export function recordReviewAction(db: Database.Database, input: RecordReviewActionInput): void {
  db.prepare(
    'INSERT INTO review_history (symbol_id, doc_id, rel_type, action, actor) VALUES (?, ?, ?, ?, ?)',
  ).run(input.symbol_id, input.doc_id, input.rel_type, input.action, input.actor ?? 'cli');
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/**
 * List review decisions, newest first. LEFT JOINs against symbols and
 * doc_sections so rows survive deletion of the referenced entities
 * (enriched fields come back null in that case).
 */
export function listReviewHistory(
  db: Database.Database,
  opts: { limit?: number; symbol_id?: string } = {},
): EnrichedReviewHistoryRow[] {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const base = `
    SELECT h.*, s.name AS symbol_name, d.file AS doc_file, d.anchor AS doc_anchor
    FROM review_history h
    LEFT JOIN symbols s ON s.id = h.symbol_id
    LEFT JOIN doc_sections d ON d.id = h.doc_id
  `;
  if (opts.symbol_id) {
    return db.prepare(`${base} WHERE h.symbol_id = ? ORDER BY h.id DESC LIMIT ?`)
      .all(opts.symbol_id, limit) as EnrichedReviewHistoryRow[];
  }
  return db.prepare(`${base} ORDER BY h.id DESC LIMIT ?`)
    .all(limit) as EnrichedReviewHistoryRow[];
}
