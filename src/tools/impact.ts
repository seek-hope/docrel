// src/tools/impact.ts
import type Database from 'better-sqlite3';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getDocSection } from '../db/docs.js';

export interface ImpactReport {
  changedFiles: string[];
  affectedSymbols: Array<{
    id: string;
    name: string;
    kind: string;
    location: string;
  }>;
  affectedDocs: Array<{
    id: string;
    file: string;
    anchor: string;
    doc_type: string;
    status: string;
    relationship: string;
  }>;
}

export async function docrelImpact(
  db: Database.Database,
  changedFiles: string[],
): Promise<ImpactReport> {
  const affectedSymbols: ImpactReport['affectedSymbols'] = [];
  const affectedDocs: ImpactReport['affectedDocs'] = [];
  const seenDocIds = new Set<string>();

  const seenSymbolIds = new Set<string>();

  for (const file of changedFiles) {
    try {
      // Query DB for symbols in this file, then join through mappings to docs
      const allSymbols = db.prepare(
        'SELECT id, name, kind, location FROM symbols WHERE location LIKE ?',
      ).all(`${file}%`) as Array<{ id: string; name: string; kind: string; location: string }>;

      for (const dbSym of allSymbols) {
        if (seenSymbolIds.has(dbSym.id)) continue;
        seenSymbolIds.add(dbSym.id);
        affectedSymbols.push(dbSym);

        const mappings = getMappingsForSymbol(db, dbSym.id);
        for (const mapping of mappings) {
          if (seenDocIds.has(mapping.doc_id)) continue;
          seenDocIds.add(mapping.doc_id);

          const doc = getDocSection(db, mapping.doc_id);
          if (doc) {
            affectedDocs.push({
              id: doc.id,
              file: doc.file,
              anchor: doc.anchor,
              doc_type: doc.doc_type,
              status: doc.status,
              relationship: mapping.rel_type,
            });
          }
        }
      }
    } catch {
      // Skip files that cause errors (e.g., unindexed)
    }
  }

  return { changedFiles, affectedSymbols, affectedDocs };
}
