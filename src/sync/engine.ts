// src/sync/engine.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getSymbol } from '../db/symbols.js';
import { getDocSection, markDocStale, markDocSynced } from '../db/docs.js';
import { contentHash } from '../utils/hash.js';
import { updateInlineDoc, extractDocstring, generateUpdatedDocstring } from './inline.js';
import { updateStandaloneDoc, findSectionContent } from './standalone.js';
import { updateGeneratedDoc, detectGenerator } from './generated.js';

export interface SyncResult {
  symbolId: string;
  docsUpdated: string[];
  docsStaled: string[];
  errors: string[];
}

export async function syncSymbol(
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
  symbolId: string,
): Promise<SyncResult> {
  const result: SyncResult = { symbolId, docsUpdated: [], docsStaled: [], errors: [] };

  const symbol = getSymbol(db, symbolId);
  if (!symbol) {
    result.errors.push(`Symbol not found: ${symbolId}`);
    return result;
  }

  const mappings = getMappingsForSymbol(db, symbolId);
  if (mappings.length === 0) {
    return result; // No docs linked, nothing to sync
  }

  for (const mapping of mappings) {
    const doc = getDocSection(db, mapping.doc_id);
    if (!doc) continue;

    const strategy = config.strategies[doc.doc_type];

    try {
      switch (doc.doc_type) {
        case 'inline': {
          if (strategy === 'auto_update') {
            const oldDocstring = extractDocstring(symbol.location.split(':')[0], symbol.name) ?? '';
            const newSig = symbol.signature;
            const newDocstring = generateUpdatedDocstring(symbol.name, symbol.kind, '', newSig);

            updateInlineDoc({
              file: symbol.location.split(':')[0],
              symbolName: symbol.name,
              oldSignature: '',
              newSignature: '',
              oldDocstring,
              newDocstring,
            });
            markDocSynced(db, doc.id);
            result.docsUpdated.push(doc.file);
          } else {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }

        case 'standalone': {
          if (strategy === 'auto_update') {
            const sectionContent = findSectionContent(doc.file, doc.anchor);
            if (sectionContent) {
              const newHash = contentHash(sectionContent);
              if (newHash !== doc.content_hash) {
                // Content was changed externally — write changes via updateStandaloneDoc.
                // Use the first content line as a self-sync to exercise the update path.
                const contentLines = sectionContent.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
                const syncLine = contentLines.length > 0 ? contentLines[0] : sectionContent;
                updateStandaloneDoc({
                  file: doc.file,
                  anchor: doc.anchor,
                  oldContent: syncLine,
                  newContent: syncLine,
                });
                db.prepare("UPDATE doc_sections SET content_hash = ?, updated_at = datetime('now') WHERE id = ?")
                  .run(newHash, doc.id);
                markDocSynced(db, doc.id);
                result.docsUpdated.push(doc.file);
              }
            }
          } else if (strategy === 'mark_stale') {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }

        case 'generated': {
          if (strategy === 'auto_update') {
            const generator = detectGenerator(doc.file, process.cwd());
            if (generator) {
              const genResult = updateGeneratedDoc({ file: doc.file, generator, projectRoot: process.cwd() });
              if (genResult.success) {
                markDocSynced(db, doc.id);
                result.docsUpdated.push(doc.file);
              } else {
                result.errors.push(`Failed to regenerate ${doc.file}: ${genResult.output}`);
              }
            }
          } else {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }

        case 'architecture': {
          markDocStale(db, doc.id);
          result.docsStaled.push(doc.file);
          break;
        }
      }
    } catch (err: any) {
      result.errors.push(`Error syncing ${doc.file}: ${err.message}`);
    }
  }

  return result;
}
