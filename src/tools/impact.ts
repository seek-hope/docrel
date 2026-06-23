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
  errors: Array<{ file: string; message: string }>;
}

function escapeLike(str: string): string {
  // Escape backslash first so that literal backslashes in the path
  // don't combine with our escape-inserted backslashes.
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function docrelImpact(
  db: Database.Database,
  changedFiles: string[],
): ImpactReport {
  const affectedSymbols: ImpactReport['affectedSymbols'] = [];
  const affectedDocs: ImpactReport['affectedDocs'] = [];
  const errors: ImpactReport['errors'] = [];
  const seenDocIds = new Set<string>();

  const seenSymbolIds = new Set<string>();

  const MAX_PATH_LENGTH = 4096;

  for (const file of changedFiles) {
    if (file.length > MAX_PATH_LENGTH) {
      console.error(`Warning: Skipping path exceeding ${MAX_PATH_LENGTH} chars: ${file.slice(0, 100)}...`);
      errors.push({ file, message: `Path exceeds ${MAX_PATH_LENGTH} characters` });
      continue;
    }
    try {
      const escaped = escapeLike(file);
      // Match locations in "file:line" format via LIKE prefix match
      const allSymbols = db.prepare(
        `SELECT id, name, kind, location FROM symbols
         WHERE location LIKE ? || ':%' ESCAPE '\\'`
      ).all(escaped) as Array<{ id: string; name: string; kind: string; location: string }>;

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
    } catch (err: any) {
      console.error(`Warning: Skipping ${file} due to error: ${err.message}`);
      errors.push({ file, message: err.message });
    }
  }

  return { changedFiles, affectedSymbols, affectedDocs, errors };
}
