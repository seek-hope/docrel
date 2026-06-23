// src/tools/impact.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getSymbol } from '../db/symbols.js';
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
  codegraph: CodegraphClient,
  changedFiles: string[],
): Promise<ImpactReport> {
  const affectedSymbols: ImpactReport['affectedSymbols'] = [];
  const affectedDocs: ImpactReport['affectedDocs'] = [];
  const seenDocIds = new Set<string>();

  for (const file of changedFiles) {
    // Find symbols in changed files
    try {
      const result = await codegraph.explore(`symbols in ${file}`, 20);

      for (const sym of result.symbols) {
        // Look up each symbol in our database
        const allSymbols = db.prepare(
          'SELECT id, name, kind, location FROM symbols WHERE location LIKE ?',
        ).all(`${file}%`) as Array<{ id: string; name: string; kind: string; location: string }>;

        for (const dbSym of allSymbols) {
          affectedSymbols.push(dbSym);

          // Find linked docs through mappings
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
      }
    } catch {
      // codegraph may not have indexed this file yet — skip
    }
  }

  return { changedFiles, affectedSymbols, affectedDocs };
}
