import type Database from 'better-sqlite3';
import { cachedStmt } from './statements.js';
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
  //
  // updated_at means "last time the symbol CHANGED" — status.ts surfaces
  // MAX(updated_at) as the last-change timestamp and the scanner already
  // skips unchanged symbols caller-side. Preserve it at the SQL level too
  // (same convention as upsertDocSection's stale/draft timestamp) so the
  // other callers of this function can't bump it with a byte-identical
  // re-write. Comparisons are NULL-safe: every column above defaults to ''.
  const row = cachedStmt(db, `
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
      updated_at = CASE
        WHEN symbols.name = excluded.name
         AND symbols.kind = excluded.kind
         AND symbols.project = excluded.project
         AND symbols.location = excluded.location
         AND symbols.signature = excluded.signature
         AND symbols.raw_signature = excluded.raw_signature
         AND symbols.metadata = excluded.metadata
        THEN symbols.updated_at
        ELSE datetime('now')
      END
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
  return cachedStmt(db, 'SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
}

/** Symbols whose simple name matches exactly (cap defensively — name lookups
 *  are a CLI convenience, never a bulk path). */
export function findSymbolsByName(db: Database.Database, name: string): SymbolRow[] {
  return db.prepare('SELECT * FROM symbols WHERE name = ? ORDER BY project, location LIMIT 1000').all(name) as SymbolRow[];
}

/**
 * Resolve user-supplied symbol input to a symbol ID: exact ID first, then a
 * unique simple-name match. Users think in names (`login`), the database
 * thinks in IDs — meeting them at the name is the difference between the
 * command working and a trip to `status` output to copy an ID. Ambiguous
 * names fail with a candidate list so the fix is one copy-paste away.
 */
export function resolveSymbolId(
  db: Database.Database,
  input: string,
): { id: string; via: 'id' | 'name' } | { error: string } {
  const exact = getSymbol(db, input);
  if (exact) return { id: exact.id, via: 'id' };
  const byName = findSymbolsByName(db, input);
  if (byName.length === 1) return { id: byName[0].id, via: 'name' };
  if (byName.length > 1) {
    const shown = byName.slice(0, 10)
      .map((s) => `  ${s.location} — ${s.id}`)
      .join('\n');
    const more = byName.length > 10 ? `\n  … and ${byName.length - 10} more` : '';
    return { error: `'${input}' matches ${byName.length} symbols — re-run with the full symbol ID:\n${shown}${more}` };
  }
  return { error: `Symbol not found: ${input} (looked up by exact ID and by name)` };
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
