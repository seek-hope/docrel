// src/tools/link.ts
import type Database from 'better-sqlite3';
import { createMapping, deleteMapping } from '../db/mappings.js';

export interface LinkResult {
  action: 'created' | 'deleted' | 'error';
  symbol_id: string;
  doc_id: string;
  rel_type: string;
  message: string;
}

export function docrelLink(
  db: Database.Database,
  params: {
    action: 'create' | 'delete';
    symbol_id: string;
    doc_id: string;
    rel_type: string;
  },
): LinkResult {
  try {
    if (params.action === 'create') {
      createMapping(db, {
        symbol_id: params.symbol_id,
        doc_id: params.doc_id,
        rel_type: params.rel_type as 'describes',
      });
      return { action: 'created', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping created.' };
    } else {
      deleteMapping(db, params.symbol_id, params.doc_id, params.rel_type);
      return { action: 'deleted', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping deleted.' };
    }
  } catch (err: any) {
    return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: err.message };
  }
}
