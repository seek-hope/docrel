// src/tools/ack.ts — Acknowledge stale doc sections as accurate
import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';
import { getDocSection, markDocRelayed, resolveDocSectionId } from '../db/docs.js';

export interface AckEntry {
  id: string;
  file: string;
  anchor: string;
}

export interface AckReport {
  /** Sections transitioned stale -> in_sync. */
  acknowledged: AckEntry[];
  /** Sections that were NOT stale (informational — nothing changed). */
  notStale: Array<AckEntry & { status: string }>;
  /** Requested doc ids that do not exist in the database. */
  notFound: string[];
}

/** Matches the sync --all-stale cap: batches beyond this need a second run,
 *  which also keeps a pathological DB from producing an unbounded report. */
const MAX_ACK_ALL = 5000;

/**
 * Mark stale doc sections as in_sync after a human/agent reviewed them and
 * found the content still accurate.
 *
 * Why this exists: a section goes stale whenever a LINKED symbol's signature
 * changes (scan) or a sync pass cannot verify it. When the section never
 * quoted the signature (loose auto-link, prose mention), there is nothing to
 * rewrite — sync deliberately leaves it stale ("could not locate documented
 * signature text"). Without an acknowledgement path the section was stuck:
 * `check --strict` (pre-commit/pre-push) failed forever. `confirm` does not
 * help — it records mapping review_status, not section staleness.
 *
 * This is a human decision, not an inference: the caller asserts the content
 * is accurate DESPITE the recorded change, so no content verification runs
 * here. The next scan refreshes content_hash as usual.
 */
export function docrelayAck(
  db: Database.Database,
  opts: { docId?: string; all?: boolean },
): AckReport {
  assertDbOpen(db);
  const report: AckReport = { acknowledged: [], notStale: [], notFound: [] };

  if (opts.all) {
    const stale = db.prepare(
      "SELECT id, file, anchor FROM doc_sections WHERE status = 'stale' ORDER BY id LIMIT ?",
    ).all(MAX_ACK_ALL) as AckEntry[];
    db.transaction(() => {
      for (const row of stale) {
        if (markDocRelayed(db, row.id)) {
          report.acknowledged.push(row);
        } else {
          // Deleted between the SELECT and the UPDATE — not an error, but
          // callers should not count it as acknowledged.
          report.notFound.push(row.id);
        }
      }
    })();
    return report;
  }

  const docId = opts.docId;
  if (!docId) {
    throw new Error('ack requires a doc id or all=true');
  }
  // Accept file#anchor or a unique bare anchor in addition to the full ID.
  // Ambiguity is a usage error (throw with candidates); a simple miss keeps
  // the structured notFound report.
  const resolved = resolveDocSectionId(db, docId);
  if ('error' in resolved) {
    if (resolved.error.includes('matches')) throw new Error(resolved.error);
    report.notFound.push(docId);
    return report;
  }
  const row = getDocSection(db, resolved.id);
  if (!row) {
    report.notFound.push(docId); // concurrent delete between the two reads
    return report;
  }
  if (row.status !== 'stale') {
    report.notStale.push({ id: row.id, file: row.file, anchor: row.anchor, status: row.status });
    return report;
  }
  if (markDocRelayed(db, row.id)) {
    report.acknowledged.push({ id: row.id, file: row.file, anchor: row.anchor });
  } else {
    report.notFound.push(row.id); // concurrent delete — see the --all path
  }
  return report;
}
