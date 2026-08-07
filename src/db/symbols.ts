import type Database from 'better-sqlite3';
import { markDocsStaleForSymbol } from './docs.js';

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
  kind: 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable' | 'unknown';
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
  // Validate kind against allowed values and default unknown kinds instead of
  // letting SQLite reject with a cryptic CHECK constraint violation.
  const ALLOWED_KINDS = new Set<SymbolRow['kind']>([
    'function', 'class', 'module', 'api_endpoint', 'type', 'interface', 'variable', 'unknown',
  ]);
  if (!input.kind || !ALLOWED_KINDS.has(input.kind)) {
    if (input.kind) console.warn(`DocRelay: upsertSymbol received unknown kind '${input.kind}' — defaulting to 'unknown'`);
    input.kind = 'unknown';
  }
  // Use UPSERT with RETURNING to atomically insert/update and read back
  // the row in a single statement. This avoids the TOCTOU race where a
  // concurrent DELETE between the UPSERT and a separate SELECT causes a
  // spurious "was not found after upsert" error.
  const row = db.prepare(`
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
    RETURNING *
  `).get(
    input.id,
    input.name,
    input.kind,
    input.project ?? '',
    input.location ?? '',
    input.signature ?? '',
    input.raw_signature ?? '',
    safeStringify(input.metadata ?? {}),
  ) as SymbolRow | undefined;

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

  query += ' ORDER BY project, name LIMIT 50000';
  return db.prepare(query).all(...params) as SymbolRow[];
}

export function deleteSymbol(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM symbols WHERE id = ?').run(id);
}

/**
 * Mark all non-rejected docs mapped to the symbol as 'stale' and insert a
 * `signature_changed` changelog entry, populating `affected_docs` with the
 * doc ids that were marked stale. When no docs are affected, sync_status is
 * 'applied' (the signature was recorded but nothing needs updating); when docs
 * were marked stale, sync_status is 'pending' so the sync layer processes them.
 * Returns the list of affected doc ids.
 */
export function recordSignatureChange(
  db: Database.Database,
  id: string,
  oldSig: string,
  newSig: string,
  rawSigs?: { oldRaw?: string; newRaw?: string },
): string[] {
  const affected = markDocsStaleForSymbol(db, id);
  // Store human-readable signature TEXT in the changelog (not the content
  // hash) so the sync layer can locate the old documented signature in the
  // doc and surgically replace it. Fall back to the hash for legacy callers.
  const oldSigText = rawSigs?.oldRaw || oldSig;
  const newSigText = rawSigs?.newRaw || newSig;
  db.prepare(`
    INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig, affected_docs, sync_status)
    VALUES (?, 'signature_changed', ?, ?, ?, ?)
  `).run(id, oldSigText, newSigText, safeStringify(affected), affected.length > 0 ? 'pending' : 'applied');
  return affected;
}

export function markSignatureChanged(
  db: Database.Database,
  id: string,
  oldSig: string,
  newSig: string,
  newRawSig?: string,
  oldRawSig?: string,
): boolean {
  // Update both the signature hash and the human-readable raw_signature
  // to keep them synchronized. Without updating raw_signature, callers
  // would get mismatched hash/raw pairs after this call.
  const info = db.prepare(
    newRawSig !== undefined
      ? "UPDATE symbols SET signature = ?, raw_signature = ?, updated_at = datetime('now') WHERE id = ?"
      : "UPDATE symbols SET signature = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(...(newRawSig !== undefined ? [newSig, newRawSig, id] : [newSig, id]));

  // Only insert changelog/cascade if the symbol actually exists — avoids orphans
  if (info.changes === 0) {
    console.warn(`DocRelay: markSignatureChanged called for non-existent symbol: ${id}`);
    return false;
  }

  recordSignatureChange(db, id, oldSig, newSig, { oldRaw: oldRawSig, newRaw: newRawSig });
  return true;
}

/**
 * Insert a `created` changelog entry for a newly discovered symbol. New
 * symbols normally have no mappings yet, so sync_status is 'applied' and
 * affected_docs is empty — matching the existing scan style.
 */
export function recordSymbolCreated(db: Database.Database, id: string, newSig: string): void {
  db.prepare(`
    INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig, affected_docs, sync_status)
    VALUES (?, 'created', '', ?, '[]', 'applied')
  `).run(id, newSig);
}
