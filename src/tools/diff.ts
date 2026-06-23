// src/tools/diff.ts
import type Database from 'better-sqlite3';
import { getSymbol } from '../db/symbols.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getDocSection } from '../db/docs.js';

export interface DiffReport {
  symbol: {
    id: string;
    name: string;
    currentSignature: string;
  };
  changeLog: Array<{
    timestamp: string;
    change_type: string;
    old_sig: string;
    new_sig: string;
    sync_status: string;
  }>;
  affectedDocs: Array<{
    file: string;
    anchor: string;
    status: string;
  }>;
}

export function docrelDiff(db: Database.Database, symbolId: string): DiffReport | null {
  try {
    const symbol = getSymbol(db, symbolId);
    if (!symbol) return null;

    const changelog = db.prepare(
      'SELECT * FROM changelog WHERE symbol_id = ? ORDER BY timestamp DESC LIMIT 10',
    ).all(symbolId) as Array<{
      timestamp: string; change_type: string; old_sig: string; new_sig: string; sync_status: string;
    }>;

    const mappings = getMappingsForSymbol(db, symbolId);
    const affectedDocs = mappings.map((m) => {
      const doc = getDocSection(db, m.doc_id);
      return { file: doc?.file ?? 'unknown', anchor: doc?.anchor ?? '', status: doc?.status ?? 'unknown' };
    });

    return {
      symbol: { id: symbol.id, name: symbol.name, currentSignature: symbol.signature },
      changeLog: changelog,
      affectedDocs,
    };
  } catch (err: any) {
    console.error('docrelDiff failed:', err.message);
    return null;
  }
}
