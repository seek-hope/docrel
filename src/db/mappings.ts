import type Database from 'better-sqlite3';

export type ReviewStatus = 'auto' | 'confirmed' | 'rejected';

export interface MappingRow {
  symbol_id: string; doc_id: string;
  rel_type: 'describes' | 'references' | 'generates' | 'contracts';
  review_status: ReviewStatus; created_at: string;
}

export interface MappingInput {
  symbol_id: string; doc_id: string;
  rel_type: MappingRow['rel_type']; review_status?: ReviewStatus;
}

export function createMapping(db: Database.Database, input: MappingInput): MappingRow {
  const status = input.review_status ?? 'auto';
  const row = db.prepare(`
    INSERT INTO mappings (symbol_id, doc_id, rel_type, review_status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (symbol_id, doc_id, rel_type) DO UPDATE SET review_status = excluded.review_status
    RETURNING *
  `).get(input.symbol_id, input.doc_id, input.rel_type, status) as MappingRow | undefined;
  if (!row) throw new Error("Mapping was not found after insert");
  return row;
}

export function getMappingsForSymbol(db: Database.Database, symbolId: string): MappingRow[] {
  if (!symbolId) return [];
  return db.prepare("SELECT * FROM mappings WHERE symbol_id = ?").all(symbolId) as MappingRow[];
}

export function getMappingsForDoc(db: Database.Database, docId: string): MappingRow[] {
  if (!docId) return [];
  return db.prepare("SELECT * FROM mappings WHERE doc_id = ?").all(docId) as MappingRow[];
}

export function listAllMappings(db: Database.Database): MappingRow[] {
  return db.prepare("SELECT * FROM mappings ORDER BY symbol_id").all() as MappingRow[];
}

export function setReviewStatus(db: Database.Database, sid: string, did: string, rt: string, st: ReviewStatus): MappingRow | null {
  if (!sid || !did) return null;
  const row = db.prepare("UPDATE mappings SET review_status = ? WHERE symbol_id = ? AND doc_id = ? AND rel_type = ? RETURNING *").get(st, sid, did, rt) as MappingRow | undefined;
  return row ?? null;
}

export function deleteMapping(db: Database.Database, sid: string, did: string, rt: string): boolean {
  if (!sid || !did) return false;
  return (db.prepare("DELETE FROM mappings WHERE symbol_id = ? AND doc_id = ? AND rel_type = ?").run(sid, did, rt).changes > 0);
}

export function exportMappingsJson(db: Database.Database): any[] {
  return db.prepare("SELECT s.name AS symbol_name, d.file AS doc_file, d.anchor AS doc_anchor, m.rel_type, m.review_status FROM mappings m JOIN symbols s ON s.id = m.symbol_id JOIN doc_sections d ON d.id = m.doc_id ORDER BY s.name, d.file").all() as any[];
}
