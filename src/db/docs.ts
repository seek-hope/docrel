import type Database from 'better-sqlite3';
import { cachedStmt } from './statements.js';
import { docSectionId } from '../utils/hash.js';

export interface DocSectionRow {
  id: string;
  file: string;
  anchor: string;
  content_hash: string;
  doc_type: 'inline' | 'standalone' | 'generated' | 'architecture';
  status: 'in_sync' | 'stale' | 'draft';
  created_at: string;
  updated_at: string;
}

export interface DocSectionInput {
  id: string;
  file: string;
  anchor?: string;
  content_hash?: string;
  doc_type: DocSectionRow['doc_type'];
  status?: DocSectionRow['status'];
}

export function upsertDocSection(db: Database.Database, input: DocSectionInput): DocSectionRow {
  // Validate required fields before database operations to produce clear
  // error messages rather than cryptic SQLite constraint violations.
  if (!input.id) throw new Error('doc_section id cannot be empty');
  if (!input.file) throw new Error('doc_section file cannot be empty');
  if (!input.doc_type) throw new Error('doc_section doc_type cannot be empty');

  // Use UPSERT with RETURNING to atomically insert/update and read back
  // the row in a single statement. This avoids the TOCTOU race where a
  // concurrent DELETE between the UPSERT and a separate SELECT causes a
  // spurious "was not found after upsert" error.
  //
  // updated_at mirrors the status rule for stale/draft docs: it is the
  // stale-mark timestamp, NOT the last observation time. The sync engine's
  // standalone mtime-recovery compares the doc file's mtime against
  // updated_at to decide whether the file was rewritten after staling —
  // bumping it on every scan (which always re-observes the file) would make
  // that comparison impossible to satisfy and leave agent-fixed docs
  // permanently stale (see sync/engine.ts, the standalone 'stale' branch).
  const row = cachedStmt(db, `
    INSERT INTO doc_sections (id, file, anchor, content_hash, doc_type, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      file = excluded.file,
      anchor = excluded.anchor,
      content_hash = excluded.content_hash,
      doc_type = excluded.doc_type,
      status = CASE WHEN doc_sections.status IN ('stale', 'draft') THEN doc_sections.status ELSE excluded.status END,
      updated_at = CASE WHEN doc_sections.status IN ('stale', 'draft') THEN doc_sections.updated_at ELSE datetime('now') END
    RETURNING *
  `).get(input.id, input.file, input.anchor ?? '', input.content_hash ?? '', input.doc_type, input.status ?? 'in_sync') as DocSectionRow | undefined;

  if (!row) throw new Error(`DocSection ${input.id} was not found after upsert`);
  return row;
}

export function getDocSection(db: Database.Database, id: string): DocSectionRow | undefined {
  return db.prepare('SELECT * FROM doc_sections WHERE id = ?').get(id) as DocSectionRow | undefined;
}

/**
 * Resolve user-supplied doc-section input to a section ID. Users think in
 * `docs/api.md#login` (or a bare `login` anchor), the database keys on
 * 64-char IDs — same UX gap as symbols (see resolveSymbolId). Resolution
 * order: exact ID, then exact `file#anchor`, then a unique bare anchor.
 * Ambiguous input fails with a candidate list (file#anchor + full ID) so
 * the fix is one copy-paste away.
 */
export function resolveDocSectionId(
  db: Database.Database,
  input: string,
): { id: string } | { error: string } {
  const exact = getDocSection(db, input);
  if (exact) return { id: exact.id };

  const hashIdx = input.lastIndexOf('#');
  if (hashIdx > 0) {
    const file = input.slice(0, hashIdx);
    const anchor = input.slice(hashIdx + 1);
    const row = db.prepare('SELECT * FROM doc_sections WHERE file = ? AND anchor = ?').get(file, anchor) as DocSectionRow | undefined;
    if (row) return { id: row.id };
  }

  const byAnchor = db.prepare('SELECT * FROM doc_sections WHERE anchor = ? ORDER BY file LIMIT 1000').all(input) as DocSectionRow[];
  if (byAnchor.length === 1) return { id: byAnchor[0].id };
  if (byAnchor.length > 1) {
    const shown = byAnchor.slice(0, 10)
      .map((d) => `  ${d.file}#${d.anchor} — ${d.id}`)
      .join('\n');
    const more = byAnchor.length > 10 ? `\n  … and ${byAnchor.length - 10} more` : '';
    return { error: `'${input}' matches ${byAnchor.length} doc sections — re-run with file#anchor or the full ID:\n${shown}${more}` };
  }
  return { error: `Doc section not found: ${input} (looked up by ID, file#anchor, and anchor)` };
}

export function listDocSections(db: Database.Database, filter?: { doc_type?: string; status?: string }): DocSectionRow[] {
  let query = 'SELECT * FROM doc_sections WHERE 1=1';
  const params: string[] = [];

  if (filter?.doc_type) { query += ' AND doc_type = ?'; params.push(filter.doc_type); }
  if (filter?.status) { query += ' AND status = ?'; params.push(filter.status); }

  query += ' ORDER BY file, anchor LIMIT 50000';
  return db.prepare(query).all(...params) as DocSectionRow[];
}

export function markDocStale(db: Database.Database, id: string): boolean {
  const info = db.prepare("UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?").run(id);
  if (info.changes === 0) {
    console.warn(`DocRelay: markDocStale called for non-existent doc: ${id}`);
    return false;
  }
  return true;
}

/**
 * Mark every doc_section mapped to the given symbol (excluding explicitly
 * rejected mappings) as 'stale'. Statically marks the linked docs stale so
 * that `check`/`syncAllStale` (which only query status='stale') pick them up.
 * Returns the list of doc ids that were actually marked stale.
 */
export function markDocsStaleForSymbol(db: Database.Database, symbolId: string): string[] {
  if (!symbolId) return [];
  // Evidence gate: cascade only through mappings a human confirmed, or whose
  // auto-link evidence is strong (>= 0.7: backtick / codeblock / heading
  // matches — the doc actually quotes the symbol). Weak auto links (0.4
  // bodytext prose mentions, 0.6 fuzzy headings) are review candidates, not
  // facts: letting them stale docs cried wolf on every signature change
  // (a single common-word symbol could stale dozens of unrelated sections).
  const rows = cachedStmt(db,
    `SELECT doc_id FROM mappings
     WHERE symbol_id = ? AND review_status != 'rejected'
       AND (review_status = 'confirmed' OR confidence >= 0.7)`
  ).all(symbolId) as Array<{ doc_id: string }>;
  if (rows.length === 0) return [];

  const stmt = cachedStmt(db, "UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?");
  const affected: string[] = [];
  for (const { doc_id } of rows) {
    if (stmt.run(doc_id).changes > 0) affected.push(doc_id);
  }
  return affected;
}

/**
 * Mark only the `inline` doc_sections linked to the given symbol as stale.
 * Unlike markDocsStaleForSymbol (which stales every linked doc regardless of
 * type), this targets inline docs specifically — used when a still-present
 * symbol no longer has a captured docstring during a scan, so the previously
 * collected inline doc_section is treated as removed. Returns the doc ids that
 * were actually marked stale.
 */
export function markInlineStaleForSymbol(db: Database.Database, symbolId: string): string[] {
  if (!symbolId) return [];
  const rows = cachedStmt(db,
    `SELECT d.id, d.doc_type FROM mappings m
     JOIN doc_sections d ON d.id = m.doc_id
     WHERE m.symbol_id = ?`
  ).all(symbolId) as Array<{ id: string; doc_type: DocSectionRow['doc_type'] }>;
  const inline = rows.filter((r) => r.doc_type === 'inline');
  const stmt = cachedStmt(db, "UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?");
  const affected: string[] = [];
  for (const { id } of inline) {
    if (stmt.run(id).changes > 0) affected.push(id);
  }
  return affected;
}


export function markDocRelayed(db: Database.Database, id: string): boolean {
  const info = cachedStmt(db, "UPDATE doc_sections SET status = 'in_sync', updated_at = datetime('now') WHERE id = ?").run(id);
  if (info.changes === 0) {
    console.warn(`DocRelay: markDocRelayed called for non-existent doc: ${id}`);
    return false;
  }
  return true;
}

/**
 * Atomically update both content_hash and status in a single UPDATE statement.
 * This prevents a crash between separate UPDATE calls from leaving the doc in
 * an inconsistent state (content_hash updated but status still 'stale').
 */
export function markDocRelayedWithHash(db: Database.Database, id: string, newHash: string): boolean {
  const info = db.prepare(
    "UPDATE doc_sections SET content_hash = ?, status = 'in_sync', updated_at = datetime('now') WHERE id = ?"
  ).run(newHash, id);
  if (info.changes === 0) {
    console.warn(`DocRelay: markDocRelayedWithHash called for non-existent doc: ${id}`);
    return false;
  }
  return true;
}

/**
 * Delete 'standalone' doc_sections rows whose anchors no longer appear in a
 * successfully parsed doc file ("ghost sections").
 *
 * The scan pipeline upserts the sections it finds but never removed rows for
 * renamed or deleted headings, so ghost rows accumulated in_sync until a
 * later sync pass staled them — after which they could NEVER recover (sync
 * cannot locate the vanished anchor to rewrite or hash-match it), failing
 * `check --strict` permanently. Mappings cascade-delete with the row via the
 * foreign key; the deliberately FK-free review_history table preserves the
 * audit trail.
 *
 * Safety contract (callers uphold it): only files that parsed SUCCESSFULLY
 * may appear as keys — a file that failed to read/parse must keep its rows,
 * otherwise a transient parser failure would mass-delete sections. Only
 * doc_type 'standalone' rows are touched: 'inline' rows belong to code files
 * (never parsed by scanDocs) and 'generated' rows are managed by the
 * generated-doc updater.
 *
 * @param fileAnchors  map of doc file (project-relative) -> anchors parsed
 *                     from it in this scan (possibly an empty set).
 * @returns number of deleted rows.
 */
export function pruneVanishedDocSections(
  db: Database.Database,
  fileAnchors: Map<string, Set<string>>,
): number {
  let pruned = 0;
  const rowsForFile = db.prepare("SELECT id, anchor FROM doc_sections WHERE file = ? AND doc_type = 'standalone'");
  const deleteById = db.prepare("DELETE FROM doc_sections WHERE id = ? AND doc_type = 'standalone'");
  db.transaction(() => {
    for (const [file, anchors] of fileAnchors) {
      const keep = new Set<string>();
      for (const anchor of anchors) {
        const id = docSectionId(file, anchor);
        if (id) keep.add(id);
      }
      const rows = rowsForFile.all(file) as Array<{ id: string; anchor: string }>;
      for (const row of rows) {
        if (keep.has(row.id)) continue;
        // Deleting by id (not anchor) is collision-safe: docSectionId is the
        // primary key, so a ghost and a live section can never share it.
        pruned += deleteById.run(row.id).changes;
      }
    }
  })();
  return pruned;
}
