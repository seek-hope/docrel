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
  const confidence = input.confidence ?? 1.0;
  // Validate confidence range before the INSERT to produce a clear error
  // message rather than a cryptic SQLite CHECK constraint violation.
  if (confidence < 0 || confidence > 1) {
    throw new Error(`confidence must be between 0.0 and 1.0, got ${confidence}`);
  }
  // Use UPSERT with RETURNING * to atomically insert and read back in one
  // statement, matching the pattern in symbols.ts and docs.ts. This eliminates
  // the TOCTOU gap from the previous separate SELECT after INSERT.
  const row = db.prepare(`
    INSERT INTO mappings (symbol_id, doc_id, rel_type, confidence)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (symbol_id, doc_id, rel_type) DO UPDATE SET
      confidence = excluded.confidence
    RETURNING *
  `).get(input.symbol_id, input.doc_id, input.rel_type, confidence) as MappingRow | undefined;
  if (!row) throw new Error(`Mapping was not found after insert for ${input.symbol_id} -> ${input.doc_id}`);
  return row;
}

export function getMappingsForSymbol(db: Database.Database, symbolId: string): MappingRow[] {
  if (!symbolId) return [];
  return db.prepare('SELECT * FROM mappings WHERE symbol_id = ?').all(symbolId) as MappingRow[];
}

export function getMappingsForDoc(db: Database.Database, docId: string): MappingRow[] {
  if (!docId) return [];
  return db.prepare('SELECT * FROM mappings WHERE doc_id = ?').all(docId) as MappingRow[];
}

export function listAllMappings(db: Database.Database): MappingRow[] {
  return db.prepare('SELECT * FROM mappings ORDER BY symbol_id').all() as MappingRow[];
}

/** Update the confidence of an existing mapping. Returns the updated row or null if not found. */
export function updateConfidence(
  db: Database.Database,
  symbolId: string,
  docId: string,
  relType: string,
  confidence: number,
): MappingRow | null {
  if (!symbolId || !docId) return null;
  if (confidence < 0 || confidence > 1) {
    throw new Error(`confidence must be between 0.0 and 1.0, got ${confidence}`);
  }
  const row = db.prepare(`
    UPDATE mappings SET confidence = ?
    WHERE symbol_id = ? AND doc_id = ? AND rel_type = ?
    RETURNING *
  `).get(confidence, symbolId, docId, relType) as MappingRow | undefined;
  return row ?? null;
}

export function deleteMapping(db: Database.Database, symbolId: string, docId: string, relType: string): boolean {
  if (!symbolId || !docId) return false;
  const info = db.prepare(
    'DELETE FROM mappings WHERE symbol_id = ? AND doc_id = ? AND rel_type = ?'
  ).run(symbolId, docId, relType);
  return info.changes > 0;
}

/** Export mappings in CodeGraph-compatible format for .docrel/mappings.json */
export function exportMappingsJson(db: Database.Database): Array<{
  symbol_name: string;
  doc_file: string;
  doc_anchor: string;
  rel_type: string;
}> {
  const rows = db.prepare(`
    SELECT s.name AS symbol_name, d.file AS doc_file, d.anchor AS doc_anchor, m.rel_type
    FROM mappings m
    JOIN symbols s ON s.id = m.symbol_id
    JOIN doc_sections d ON d.id = m.doc_id
    ORDER BY s.name, d.file
  `).all() as Array<{
    symbol_name: string;
    doc_file: string;
    doc_anchor: string;
    rel_type: string;
  }>;

  return rows;
}
