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
      const deleted = deleteMapping(db, params.symbol_id, params.doc_id, params.rel_type);
      if (!deleted) {
        return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping not found.' };
      }
      return { action: 'deleted', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping deleted.' };
    }
  } catch (err: any) {
    // Check for SQLite constraint errors (SQLITE_CONSTRAINT = 19, includes FK, PK, UNIQUE, CHECK)
    const isConstraint = err.code?.startsWith('SQLITE_CONSTRAINT') || err.errno === 19;
    if (isConstraint) {
      const symExists = db.prepare('SELECT 1 FROM symbols WHERE id = ?').get(params.symbol_id);
      const docExists = db.prepare('SELECT 1 FROM doc_sections WHERE id = ?').get(params.doc_id);
      let message = `Cannot ${params.action} mapping: `;
      if (!symExists && !docExists) {
        message += 'both symbol and document section do not exist.';
      } else if (!symExists) {
        message += `symbol "${params.symbol_id}" does not exist.`;
      } else if (!docExists) {
        message += `document section "${params.doc_id}" does not exist.`;
      } else {
        message += 'constraint violation.';
      }
      return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message };
    }
    // Don't leak internal DB details to external callers
    console.error(`DocRel link error (${params.action}):`, err.message);
    return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Internal database error. Check server logs for details.' };
  }
}
