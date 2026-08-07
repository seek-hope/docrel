import type Database from 'better-sqlite3';

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
  const row = db.prepare(`
    INSERT INTO doc_sections (id, file, anchor, content_hash, doc_type, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      file = excluded.file,
      anchor = excluded.anchor,
      content_hash = excluded.content_hash,
      doc_type = excluded.doc_type,
      status = CASE WHEN doc_sections.status IN ('stale', 'draft') THEN doc_sections.status ELSE excluded.status END,
      updated_at = datetime('now')
    RETURNING *
  `).get(input.id, input.file, input.anchor ?? '', input.content_hash ?? '', input.doc_type, input.status ?? 'in_sync') as DocSectionRow | undefined;

  if (!row) throw new Error(`DocSection ${input.id} was not found after upsert`);
  return row;
}

export function getDocSection(db: Database.Database, id: string): DocSectionRow | undefined {
  return db.prepare('SELECT * FROM doc_sections WHERE id = ?').get(id) as DocSectionRow | undefined;
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
  const rows = db.prepare(
    "SELECT doc_id FROM mappings WHERE symbol_id = ? AND review_status != 'rejected'"
  ).all(symbolId) as Array<{ doc_id: string }>;
  if (rows.length === 0) return [];

  const stmt = db.prepare("UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?");
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
  const rows = db.prepare(
    `SELECT d.id, d.doc_type FROM mappings m
     JOIN doc_sections d ON d.id = m.doc_id
     WHERE m.symbol_id = ?`
  ).all(symbolId) as Array<{ id: string; doc_type: DocSectionRow['doc_type'] }>;
  const inline = rows.filter((r) => r.doc_type === 'inline');
  const stmt = db.prepare("UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?");
  const affected: string[] = [];
  for (const { id } of inline) {
    if (stmt.run(id).changes > 0) affected.push(id);
  }
  return affected;
}


export function markDocRelayed(db: Database.Database, id: string): boolean {
  const info = db.prepare("UPDATE doc_sections SET status = 'in_sync', updated_at = datetime('now') WHERE id = ?").run(id);
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
