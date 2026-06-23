import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';
import { createMapping, deleteMapping, setReviewStatus } from '../db/mappings.js';
import type { MappingRow, ReviewStatus } from '../db/mappings.js';

const VALID_REL_TYPES = new Set(['describes', 'references', 'generates', 'contracts']);

export interface LinkResult {
  action: 'created' | 'deleted' | 'updated' | 'error';
  symbol_id: string; doc_id: string; rel_type: string;
  review_status?: string; message: string;
}

export function docrelLink(
  db: Database.Database,
  p: { action: 'create' | 'delete'; symbol_id: string; doc_id: string; rel_type: string; review_status?: ReviewStatus },
): LinkResult {
  if (!VALID_REL_TYPES.has(p.rel_type))
    return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:"Invalid rel_type. Must be one of: "+[...VALID_REL_TYPES].join(', ') };
  try {
    assertDbOpen(db);
    if (p.action === 'create') {
      const row = createMapping(db, {symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type as MappingRow['rel_type'], review_status:p.review_status ?? 'auto'});
      return { action:'created', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, review_status:row.review_status, message:"Mapping created (status: "+row.review_status+")." };
    }
    const ok = deleteMapping(db, p.symbol_id, p.doc_id, p.rel_type);
    if (!ok) return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:'Mapping not found.' };
    return { action:'deleted', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:'Mapping deleted.' };
  } catch (err: any) {
    if (err.code?.startsWith('SQLITE_CONSTRAINT') || err.errno === 19) {
      try {
        const se = db.prepare('SELECT 1 FROM symbols WHERE id = ?').get(p.symbol_id);
        const de = db.prepare('SELECT 1 FROM doc_sections WHERE id = ?').get(p.doc_id);
        let m = "Cannot "+p.action+" mapping: ";
        if (!se&&!de) m+='both symbol and doc do not exist.';
        else if (!se) m+='symbol not found.';
        else if (!de) m+='doc section not found.';
        else m+='constraint violation.';
        return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:m };
      } catch { return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:'Constraint violation.' }; }
    }
    return { action:'error', symbol_id:p.symbol_id, doc_id:p.doc_id, rel_type:p.rel_type, message:'Internal DB error.' };
  }
}

export function docrelConfirm(db: Database.Database, sid: string, did: string, rt = 'describes'): LinkResult {
  const row = setReviewStatus(db, sid, did, rt, 'confirmed');
  if (!row) return { action:'error', symbol_id:sid, doc_id:did, rel_type:rt, message:'Mapping not found.' };
  return { action:'updated', symbol_id:sid, doc_id:did, rel_type:rt, review_status:'confirmed', message:'Mapping confirmed.' };
}

export function docrelReject(db: Database.Database, sid: string, did: string, rt = 'describes'): LinkResult {
  const row = setReviewStatus(db, sid, did, rt, 'rejected');
  if (!row) return { action:'error', symbol_id:sid, doc_id:did, rel_type:rt, message:'Mapping not found.' };
  return { action:'updated', symbol_id:sid, doc_id:did, rel_type:rt, review_status:'rejected', message:'Mapping rejected.' };
}
