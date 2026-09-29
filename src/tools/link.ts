import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';
import { createMapping, deleteMapping, setReviewStatus } from '../db/mappings.js';
import { resolveSymbolId } from '../db/symbols.js';
import { resolveDocSectionId } from '../db/docs.js';
import { recordReviewAction } from '../db/review-history.js';
import type { ReviewAction } from '../db/review-history.js';
import type { MappingRow, ReviewStatus } from '../db/mappings.js';

const VALID_REL_TYPES = new Set(['describes', 'references', 'generates', 'contracts']);

/** Resolve CLI/MCP-supplied identifiers: full IDs pass through, bare symbol
 *  names and doc file#anchor / unique anchors are mapped to their IDs so
 *  users never have to copy 64-char hashes by hand. */
function resolveIds(
  db: Database.Database,
  symbolInput: string,
  docInput: string,
): { symbolId: string; docId: string } | { error: string } {
  const sym = resolveSymbolId(db, symbolInput);
  if ('error' in sym) return { error: sym.error };
  const doc = resolveDocSectionId(db, docInput);
  if ('error' in doc) return { error: doc.error };
  return { symbolId: sym.id, docId: doc.id };
}

export interface LinkResult {
  action: 'created' | 'deleted' | 'updated' | 'error';
  symbol_id: string; doc_id: string; rel_type: string;
  review_status?: string; message: string;
}

export function docrelayLink(
  db: Database.Database,
  p: { action: 'create' | 'delete'; symbol_id: string; doc_id: string; rel_type: string; review_status?: ReviewStatus },
): LinkResult {
  if (!p.symbol_id || !p.doc_id)
    return { action:'error', symbol_id:p.symbol_id || '', doc_id:p.doc_id || '', rel_type:p.rel_type, message:'symbol_id and doc_id must not be empty' };
  if (!VALID_REL_TYPES.has(p.rel_type))
    return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:"Invalid rel_type. Must be one of: "+[...VALID_REL_TYPES].join(', ') };
  try {
    assertDbOpen(db);
    const ids = resolveIds(db, p.symbol_id, p.doc_id);
    if ('error' in ids) {
      return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:ids.error };
    }
    p = { ...p, symbol_id: ids.symbolId, doc_id: ids.docId };
    if (p.action === 'create') {
      // Manual links are user-asserted evidence: record them 'confirmed' so
      // the auto-linker's prune pass (which only touches 'auto' rows) and
      // the staleness cascade gate both treat them as deliberate.
      const row = createMapping(db, {symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type as MappingRow['rel_type'], review_status:p.review_status ?? 'confirmed'});
      return { action:'created', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, review_status:row.review_status, message:"Mapping created (status: "+row.review_status+")." };
    }
    const ok = deleteMapping(db, p.symbol_id, p.doc_id, p.rel_type);
    if (!ok) return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:'Mapping not found.' };
    return { action:'deleted', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:'Mapping deleted.' };
  } catch (err: any) {
    if (err.code?.startsWith('SQLITE_CONSTRAINT') || err?.errno === 19) {
      try {
        const se = db.prepare('SELECT 1 FROM symbols WHERE id = ?').get(p.symbol_id);
        const de = db.prepare('SELECT 1 FROM doc_sections WHERE id = ?').get(p.doc_id);
        let m = "Cannot "+p.action+" mapping: ";
        if (!se&&!de) m+='both symbol and doc do not exist.';
        else if (!se) m+='symbol not found.';
        else if (!de) m+='doc section not found.';
        else m+='constraint violation.';
        return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:m };
      } catch (innerErr: any) {
        console.warn('DocRelay: diagnostic query during constraint handling failed:', innerErr instanceof Error ? innerErr.message : innerErr);
        return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:`Constraint violation (diagnostic failed: ${(innerErr)?.code ?? 'unknown'})` };
      }
    }
    console.error(`DocRelay: docrelayLink ${p.action} failed for symbol=${p.symbol_id} doc=${p.doc_id}:`, err instanceof Error ? err.message : err);
    return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:'Internal DB error.' };
  }
}

/**
 * Best-effort audit trail: a failed history insert must never break the
 * review decision itself (the mapping update has already succeeded).
 */
function recordReviewActionSafe(
  db: Database.Database,
  input: { symbol_id: string; doc_id: string; rel_type: string; action: ReviewAction; actor: string },
): void {
  try {
    recordReviewAction(db, input);
  } catch (err: any) {
    console.warn('DocRelay: failed to record review history:', err instanceof Error ? err.message : err);
  }
}

export function docrelayConfirm(db: Database.Database, sid: string, did: string, rt = 'describes', actor = 'cli'): LinkResult {
  if (!sid || !did) return { action:'error', symbol_id:sid || '', doc_id:did || '', rel_type:rt, message:'symbol_id and doc_id must not be empty' };
  const ids = resolveIds(db, sid, did);
  if ('error' in ids) return { action:'error', symbol_id:sid, doc_id:did, rel_type:rt, message:ids.error };
  sid = ids.symbolId; did = ids.docId;
  const row = setReviewStatus(db, sid, did, rt, 'confirmed');
  if (!row) return { action:'error', symbol_id:sid, doc_id:did, rel_type:rt, message:'Mapping not found.' };
  recordReviewActionSafe(db, { symbol_id: sid, doc_id: did, rel_type: rt, action: 'confirmed', actor });
  return { action:'updated', symbol_id:sid, doc_id:did, rel_type:rt, review_status:'confirmed', message:'Mapping confirmed.' };
}

export function docrelayReject(db: Database.Database, sid: string, did: string, rt = 'describes', actor = 'cli'): LinkResult {
  if (!sid || !did) return { action:'error', symbol_id:sid || '', doc_id:did || '', rel_type:rt, message:'symbol_id and doc_id must not be empty' };
  const ids = resolveIds(db, sid, did);
  if ('error' in ids) return { action:'error', symbol_id:sid, doc_id:did, rel_type:rt, message:ids.error };
  sid = ids.symbolId; did = ids.docId;
  const row = setReviewStatus(db, sid, did, rt, 'rejected');
  if (!row) return { action:'error', symbol_id:sid, doc_id:did, rel_type:rt, message:'Mapping not found.' };
  recordReviewActionSafe(db, { symbol_id: sid, doc_id: did, rel_type: rt, action: 'rejected', actor });
  return { action:'updated', symbol_id:sid, doc_id:did, rel_type:rt, review_status:'rejected', message:'Mapping rejected.' };
}
