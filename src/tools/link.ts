// src/tools/link.ts
import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';
import { createMapping, deleteMapping, updateConfidence } from '../db/mappings.js';
import type { MappingRow } from '../db/mappings.js';

const VALID_REL_TYPES: ReadonlySet<string> = new Set(['describes', 'references', 'generates', 'contracts']);

export interface LinkResult {
  action: 'created' | 'deleted' | 'updated' | 'error';
  symbol_id: string;
  doc_id: string;
  rel_type: string;
  /** Only set for 'updated' and 'created' actions. */
  confidence?: number;
  message: string;
}

export function docrelLink(
  db: Database.Database,
  params: {
    action: 'create' | 'delete' | 'update';
    symbol_id: string;
    doc_id: string;
    rel_type: string;
    /** Confidence (0.0-1.0). Required for create; optional for update. */
    confidence?: number;
  },
): LinkResult {
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
    assertDbOpen(db);

    if (params.action === 'create') {
      if (params.confidence !== undefined && (params.confidence < 0 || params.confidence > 1)) {
        return {
          action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type,
          message: `confidence must be between 0.0 and 1.0, got ${params.confidence}`,
        };
      }
      const row = createMapping(db, {
        symbol_id: params.symbol_id,
        doc_id: params.doc_id,
        rel_type: rel,
        confidence: params.confidence,
      });
      return {
        action: 'created', symbol_id: params.symbol_id, doc_id: params.doc_id,
        rel_type: params.rel_type, confidence: row.confidence,
        message: `Mapping created (confidence: ${row.confidence}).`,
      };
    }

    if (params.action === 'update') {
      if (params.confidence === undefined) {
        return {
          action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type,
          message: 'confidence is required for update action',
        };
      }
      if (params.confidence < 0 || params.confidence > 1) {
        return {
          action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type,
          message: `confidence must be between 0.0 and 1.0, got ${params.confidence}`,
        };
      }
      const row = updateConfidence(db, params.symbol_id, params.doc_id, params.rel_type, params.confidence);
      if (!row) {
        return {
          action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type,
          message: 'Mapping not found. Create it first with "docrel link create".',
        };
      }
      return {
        action: 'updated', symbol_id: params.symbol_id, doc_id: params.doc_id,
        rel_type: params.rel_type, confidence: row.confidence,
        message: `Mapping confidence updated to ${row.confidence}.`,
      };
    }

    // delete
    const deleted = deleteMapping(db, params.symbol_id, params.doc_id, params.rel_type);
    if (!deleted) {
      return {
        action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type,
        message: 'Mapping not found.',
      };
    }
    return {
      action: 'deleted', symbol_id: params.symbol_id, doc_id: params.doc_id,
      rel_type: params.rel_type, message: 'Mapping deleted.',
    };
  } catch (err: any) {
    const isConstraint = err.code?.startsWith('SQLITE_CONSTRAINT') || err.errno === 19;
    if (isConstraint) {
      try {
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
      } catch {
        console.error(`DocRel link error (${params.action}):`, err.message);
        return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Constraint violation.' };
      }
    }
    console.error(`DocRel link error (${params.action}):`, err.message);
    return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Internal database error.' };
  }
}

/**
 * Shortcut: confirm a mapping — bump confidence to 1.0 (human verified).
 * Convenience wrapper around docrelLink with action='update' and confidence=1.0.
 */
export function docrelConfirm(
  db: Database.Database,
  symbolId: string,
  docId: string,
  relType = 'describes',
): LinkResult {
  return docrelLink(db, {
    action: 'update',
    symbol_id: symbolId,
    doc_id: docId,
    rel_type: relType,
    confidence: 1.0,
  });
}
