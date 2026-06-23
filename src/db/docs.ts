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
  const existing = db.prepare('SELECT id FROM doc_sections WHERE id = ?').get(input.id);

  if (existing) {
    db.prepare(`
      UPDATE doc_sections
      SET file = ?, anchor = ?, content_hash = ?, doc_type = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(input.file, input.anchor ?? '', input.content_hash ?? '', input.doc_type, input.status ?? 'in_sync', input.id);
  } else {
    db.prepare(`
      INSERT INTO doc_sections (id, file, anchor, content_hash, doc_type, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.file, input.anchor ?? '', input.content_hash ?? '', input.doc_type, input.status ?? 'in_sync');
  }

  const row = getDocSection(db, input.id);
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

export function markDocStale(db: Database.Database, id: string): void {
  db.prepare("UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function markDocSynced(db: Database.Database, id: string): void {
  db.prepare("UPDATE doc_sections SET status = 'in_sync', updated_at = datetime('now') WHERE id = ?").run(id);
}
