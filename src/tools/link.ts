// src/tools/link.ts
import type Database from 'better-sqlite3';
import { createMapping, deleteMapping } from '../db/mappings.js';
import type { MappingRow } from '../db/mappings.js';

const VALID_REL_TYPES: ReadonlySet<string> = new Set(['describes', 'references', 'generates', 'contracts']);

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
  // Validate rel_type early so the user gets a clear error
  if (!VALID_REL_TYPES.has(params.rel_type)) {
    return {
      action: 'error',
      symbol_id: params.symbol_id,
      doc_id: params.doc_id,
      rel_type: params.rel_type,
      message: `Invalid relationship type "${params.rel_type}". Must be one of: ${[...VALID_REL_TYPES].join(', ')}`,
    };
  }

  const rel = params.rel_type as MappingRow['rel_type'];

  try {
    if (params.action === 'create') {
      createMapping(db, {
        symbol_id: params.symbol_id,
        doc_id: params.doc_id,
        rel_type: rel,
      });
      return { action: 'created', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping created.' };
    } else {
      deleteMapping(db, params.symbol_id, params.doc_id, params.rel_type);
      return { action: 'deleted', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping deleted.' };
    }
  } catch (err: any) {
    // Rewrite raw SQLite FK errors into actionable messages
    const message = err.message.includes('FOREIGN KEY')
      ? `Cannot ${params.action} mapping: the symbol or document section does not exist. Create them first with 'docrel scan' or manually.`
      : err.message;
    return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message };
  }
}
