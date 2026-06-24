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
      status = CASE WHEN doc_sections.status = 'stale' THEN 'stale' ELSE excluded.status END,
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

  query += ' ORDER BY file, anchor';
  return db.prepare(query).all(...params) as DocSectionRow[];
}

export function markDocStale(db: Database.Database, id: string): boolean {
  const info = db.prepare("UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?").run(id);
  if (info.changes === 0) {
    console.warn(`DocRel: markDocStale called for non-existent doc: ${id}`);
    return false;
  }
  return true;
}

export function markDocSynced(db: Database.Database, id: string): boolean {
  const info = db.prepare("UPDATE doc_sections SET status = 'in_sync', updated_at = datetime('now') WHERE id = ?").run(id);
  if (info.changes === 0) {
    console.warn(`DocRel: markDocSynced called for non-existent doc: ${id}`);
    return false;
  }
  return true;
}

/**
 * Atomically update both content_hash and status in a single UPDATE statement.
 * This prevents a crash between separate UPDATE calls from leaving the doc in
 * an inconsistent state (content_hash updated but status still 'stale').
 */
export function markDocSyncedWithHash(db: Database.Database, id: string, newHash: string): boolean {
  const info = db.prepare(
    "UPDATE doc_sections SET content_hash = ?, status = 'in_sync', updated_at = datetime('now') WHERE id = ?"
  ).run(newHash, id);
  if (info.changes === 0) {
    console.warn(`DocRel: markDocSyncedWithHash called for non-existent doc: ${id}`);
    return false;
  }
  return true;
}
