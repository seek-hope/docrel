import type Database from 'better-sqlite3';

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '{}';
  }
}

export interface SymbolRow {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable';
  project: string;
  location: string;
  signature: string;
  raw_signature: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface SymbolInput {
  id: string;
  name: string;
  kind: SymbolRow['kind'];
  project?: string;
  location?: string;
  signature?: string;
  raw_signature?: string;
  metadata?: Record<string, unknown>;
}

export function upsertSymbol(db: Database.Database, input: SymbolInput): SymbolRow {
  if (!input.id) throw new Error('Symbol id cannot be empty');
  if (!input.name || !input.name.trim()) throw new Error('Symbol name cannot be empty');
  // Use UPSERT (INSERT ... ON CONFLICT ... DO UPDATE) to avoid the
  // check-then-act race condition. In WAL mode with concurrent processes,
  // another connection could INSERT the same row between a SELECT and INSERT.
  db.prepare(`
    INSERT INTO symbols (id, name, kind, project, location, signature, raw_signature, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      project = excluded.project,
      location = excluded.location,
      signature = excluded.signature,
      raw_signature = excluded.raw_signature,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).run(
    input.id,
    input.name,
    input.kind,
    input.project ?? '',
    input.location ?? '',
    input.signature ?? '',
    input.raw_signature ?? '',
    safeStringify(input.metadata ?? {}),
  );

  const row = getSymbol(db, input.id);
  if (!row) throw new Error(`Symbol ${input.id} was not found after upsert`);
  return row;
}

export function getSymbol(db: Database.Database, id: string): SymbolRow | undefined {
  return db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
}

export interface SymbolFilter {
  kind?: string;
  project?: string;
}

export function listSymbols(db: Database.Database, filter?: SymbolFilter): SymbolRow[] {
  let query = 'SELECT * FROM symbols WHERE 1=1';
  const params: string[] = [];

  if (filter?.kind) {
    query += ' AND kind = ?';
    params.push(filter.kind);
  }
  if (filter?.project) {
    query += ' AND project = ?';
    params.push(filter.project);
  }

  query += ' ORDER BY project, name';
  return db.prepare(query).all(...params) as SymbolRow[];
}

export function deleteSymbol(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM symbols WHERE id = ?').run(id);
}

export function markSignatureChanged(
  db: Database.Database,
  id: string,
  oldSig: string,
  newSig: string,
  newRawSig?: string,
): boolean {
  // Update both the signature hash and the human-readable raw_signature
  // to keep them synchronized. Without updating raw_signature, callers
  // would get mismatched hash/raw pairs after this call.
  const info = db.prepare(
    newRawSig !== undefined
      ? "UPDATE symbols SET signature = ?, raw_signature = ?, updated_at = datetime('now') WHERE id = ?"
      : "UPDATE symbols SET signature = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(...(newRawSig !== undefined ? [newSig, newRawSig, id] : [newSig, id]));

  // Only insert changelog if the symbol actually exists — avoids orphans
  if (info.changes === 0) {
    console.warn(`DocRel: markSignatureChanged called for non-existent symbol: ${id}`);
    return false;
  }

  db.prepare(`
    INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig)
    VALUES (?, 'signature_changed', ?, ?)
  `).run(id, oldSig, newSig);

  return true;
}
