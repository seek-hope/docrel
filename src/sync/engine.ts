// src/sync/engine.ts
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
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
  // Use lastIndexOf to find the final colon, which is the line-number separator.
  // This correctly handles Windows paths with drive letters (C:\foo\bar.ts:42)
  // and UNC paths (\\server\share\file.ts:42) where the path itself may contain colons.
  const lastColon = location.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const file = location.slice(0, lastColon);
  const lineStr = location.slice(lastColon + 1);
  const line = parseInt(lineStr, 10);
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

  try {
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
            const oldDocstring = extractDocstring(loc.file, symbol.name, projectRoot) ?? '';
            // Use raw_signature (human-readable) for JSDoc generation, not the hash.
            // If raw_signature is empty, the symbol was created without a raw signature
            // (e.g. manual creation or corrupted state) — we cannot generate meaningful docs.
            if (!symbol.raw_signature) {
              result.errors.push(`Skipped inline sync for ${symbol.name}: symbol has no raw signature (DB may be corrupted)`);
              continue;
            }
            const newSig = symbol.raw_signature;
            // Guard against empty signatures — skip replacement to avoid garbled docs
            if (!newSig) {
              result.errors.push(`Skipped inline sync for ${symbol.name}: empty signature`);
              continue;
            }
            const newDocstring = generateUpdatedDocstring(symbol.name, symbol.kind, '', newSig);

            // Extract current signature from the source to use as oldSignature
            const currentSig = extractCurrentSignature(loc.file, symbol.name, projectRoot);
            const oldSig = currentSig ?? '';

            const updated = updateInlineDoc({
              file: loc.file,
              symbolName: symbol.name,
              oldSignature: oldSig,
              newSignature: newSig,
              oldDocstring,
              newDocstring,
            }, projectRoot);

            if (updated) {
              markDocSynced(db, doc.id);
              result.docsUpdated.push(doc.file);
            } else if (!oldSig) {
              result.errors.push(`Failed to update inline doc for ${symbol.name} in ${doc.file}: could not extract current signature from source file (template types, destructured params, or non-JS syntax may cause this)`);
            } else {
              result.errors.push(`Failed to update inline doc for ${symbol.name} in ${doc.file}`);
            }
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
            const sectionContent = findSectionContent(doc.file, doc.anchor, projectRoot);
            if (sectionContent) {
              const newHash = contentHash(sectionContent);
              if (newHash !== doc.content_hash) {
                const info = db.prepare(
                  "UPDATE doc_sections SET content_hash = ?, updated_at = datetime('now') WHERE id = ?"
                ).run(newHash, doc.id);
                if (info.changes === 0) {
                  result.errors.push(`Standalone doc section ${doc.id} not found — race condition?`);
                } else {
                  markDocSynced(db, doc.id);
                  result.docsUpdated.push(doc.file);
                }
              }
            }
          } else if (strategy === 'mark_stale') {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          } else if (strategy === 'prompt') {
            result.errors.push(`Standalone doc ${doc.file}: 'prompt' strategy not yet implemented. Docs will not be auto-synced.`);
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
            } else {
              result.errors.push(`No generator found for ${doc.file}. Marking as stale.`);
              markDocStale(db, doc.id);
              result.docsStaled.push(doc.file);
            }
          } else {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }

        case 'architecture': {
          if (strategy !== 'ignore') {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }
      }
    } catch (err: any) {
      result.errors.push(`Error syncing ${doc.file}: ${err.message}`);
    }
  }
  } catch (err: any) {
    result.errors.push(`Catastrophic sync error for ${symbolId}: ${err.message}`);
  }

  return result;
}

const MAX_LINES = 100_000;

import { escapeRegex } from '../utils/fs.js';

/**
 * Extract the current function/class/const signature from the source file.
 * This is used as the oldSignature for inline doc replacement.
 * Uses a regex that matches only symbol definitions, not references.
 */
function extractCurrentSignature(file: string, symbolName: string, projectRoot: string): string | null {
  const resolved = path.resolve(projectRoot, file);

  // Containment check: prevent path traversal
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
  } catch { return null; }

  if (!fs.existsSync(resolved)) return null;
  try {
    if (fs.statSync(resolved).size > 10 * 1024 * 1024) return null;
    if (!fs.statSync(resolved).isFile()) return null;
  } catch { return null; }
  const content = fs.readFileSync(resolved, 'utf-8');
  const lines = content.split('\n');

  // Limit line count to prevent hangs on degenerate input
  if (lines.length > MAX_LINES) return null;

  const escaped = escapeRegex(symbolName);
  // Match only symbol definitions, not references or usage sites.
  // Covers: function/class/const/let/var/interface/type AND class method definitions
  // like 'async login(...) {' or 'login(data) {' which lack a keyword prefix.
  const symRegex = new RegExp(
    `(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|class)\\s+${escaped}\\b` +
    `|(?:export\\s+(?:default\\s+)?)?(?:const|let|var)\\s+${escaped}\\b\\s*=` +
    `|\\binterface\\s+${escaped}\\b` +
    `|\\btype\\s+${escaped}\\b\\s*=` +
    `|(?:async\\s+)?${escaped}\\s*\\([^)]*\\)\\s*[{:]`,
  );

  for (const line of lines) {
    if (symRegex.test(line.trim())) {
      return line.trim();
    }
  }
  return null;
}
