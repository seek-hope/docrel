// src/sync/engine.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getSymbol } from '../db/symbols.js';
import { getDocSection, markDocStale, markDocSynced } from '../db/docs.js';
import { contentHash } from '../utils/hash.js';
import { updateInlineDoc, extractDocstring, generateUpdatedDocstring } from './inline.js';
import { findSectionContent } from './standalone.js';
import { updateGeneratedDoc, detectGenerator } from './generated.js';

export interface SyncResult {
  symbolId: string;
  docsUpdated: string[];
  docsStaled: string[];
  errors: string[];
}

/** Parse a "file:line" location into { file, line }. Returns null if invalid. */
function parseLocation(location: string): { file: string; line: number } | null {
  if (!location) return null;
  const lastColon = location.lastIndexOf(':');
  if (lastColon < 0) return null;
  const file = location.slice(0, lastColon);
  const line = parseInt(location.slice(lastColon + 1), 10);
  if (!file || isNaN(line)) return null;
  return { file, line };
}

export async function syncSymbol(
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
  symbolId: string,
  projectRoot: string,
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
          const loc = parseLocation(symbol.location);
          if (!loc) {
            result.errors.push(`Cannot sync inline docs for ${symbol.name}: invalid or missing source file location`);
            continue;
          }
          if (strategy === 'auto_update') {
            const oldDocstring = extractDocstring(loc.file, symbol.name) ?? '';
            const newSig = symbol.signature;
            const newDocstring = generateUpdatedDocstring(symbol.name, symbol.kind, '', newSig);

            updateInlineDoc({
              file: loc.file,
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
            // Agent already rewrote the doc before calling syncSymbol.
            // Detect the new hash and record the sync.
            const sectionContent = findSectionContent(doc.file, doc.anchor);
            if (sectionContent) {
              const newHash = contentHash(sectionContent);
              if (newHash !== doc.content_hash) {
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
            const generator = detectGenerator(doc.file, projectRoot);
            if (generator) {
              const genResult = updateGeneratedDoc({ file: doc.file, generator, projectRoot });
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
