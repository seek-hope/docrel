import type Database from 'better-sqlite3';

export interface MappingRow {
  symbol_id: string;
  doc_id: string;
  rel_type: 'describes' | 'references' | 'generates' | 'contracts';
  confidence: number;
  created_at: string;
}

export interface MappingInput {
  symbol_id: string;
  doc_id: string;
  rel_type: MappingRow['rel_type'];
  confidence?: number;
}

export function createMapping(db: Database.Database, input: MappingInput): MappingRow {
  db.prepare(`
    INSERT OR REPLACE INTO mappings (symbol_id, doc_id, rel_type, confidence)
    VALUES (?, ?, ?, ?)
  `).run(input.symbol_id, input.doc_id, input.rel_type, input.confidence ?? 1.0);

  return getMapping(db, input.symbol_id, input.doc_id, input.rel_type)!;
}

function getMapping(db: Database.Database, symbolId: string, docId: string, relType: string): MappingRow | undefined {
  return db.prepare(
    'SELECT * FROM mappings WHERE symbol_id = ? AND doc_id = ? AND rel_type = ?',
  ).get(symbolId, docId, relType) as MappingRow | undefined;
}

export function getMappingsForSymbol(db: Database.Database, symbolId: string): MappingRow[] {
  return db.prepare('SELECT * FROM mappings WHERE symbol_id = ?').all(symbolId) as MappingRow[];
}

export function getMappingsForDoc(db: Database.Database, docId: string): MappingRow[] {
  return db.prepare('SELECT * FROM mappings WHERE doc_id = ?').all(docId) as MappingRow[];
}

export function listAllMappings(db: Database.Database): MappingRow[] {
  return db.prepare('SELECT * FROM mappings ORDER BY symbol_id').all() as MappingRow[];
}

export function deleteMapping(db: Database.Database, symbolId: string, docId: string, relType: string): void {
  db.prepare('DELETE FROM mappings WHERE symbol_id = ? AND doc_id = ? AND rel_type = ?').run(symbolId, docId, relType);
}
