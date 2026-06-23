// src/sync/engine.ts
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { assertDbOpen } from '../db/connection.js';
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
  assertDbOpen(db);
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
            const newDocstring = generateUpdatedDocstring(symbol.name, symbol.kind, '', newSig);

            // Extract current signature from the source to use as oldSignature
            const extractResult = extractCurrentSignature(loc.file, symbol.name, projectRoot);
            const oldSig = extractResult.signature ?? '';

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
              result.errors.push(`Failed to update inline doc for ${symbol.name} in ${doc.file}: ${extractResult.reason ?? 'could not extract current signature'}`);
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
            } else {
              result.errors.push(`Cannot find section '${doc.anchor}' in ${doc.file} — doc may have been restructured`);
              markDocStale(db, doc.id);
              result.docsStaled.push(doc.file);
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

        default:
          result.errors.push(`Unknown doc_type '${doc.doc_type}' for doc ${doc.id} — cannot sync`);
      }
    } catch (err: any) {
      result.errors.push(`Error syncing doc ${mapping.doc_id}: ${err.message}`);
    }
  }
  } catch (err: any) {
    result.errors.push(`Catastrophic sync error for ${symbolId}: ${err.message}`);
  }

  return result;
}

const MAX_LINES = 100_000;

import { escapeRegex, validatePath } from '../utils/fs.js';

interface ExtractResult {
  signature: string | null;
  reason?: string;
}

/**
 * Extract the current function/class/const signature from the source file.
 * This is used as the oldSignature for inline doc replacement.
 * Uses a regex that matches only symbol definitions, not references.
 * Returns a structured result with a reason when extraction fails, so
 * callers can provide specific error messages instead of a generic fallback.
 */
function extractCurrentSignature(file: string, symbolName: string, projectRoot: string): ExtractResult {
  // Use the shared validatePath() for path-traversal defense and dangling
  // symlink detection. This ensures future hardening of validatePath
  // (e.g., TOCTOU hardening, additional checks) propagates here.
  const resolved = validatePath(file, projectRoot);
  if (!resolved) return { signature: null, reason: 'invalid file path or path traversal detected' };

  let content: string;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { signature: null, reason: 'not a regular file' };
    if (stat.size > 10 * 1024 * 1024) return { signature: null, reason: 'file exceeds 10 MB size limit' };
    content = fs.readFileSync(resolved, 'utf-8');
  } catch {
    return { signature: null, reason: 'could not read source file' };
  }
  const lines = content.split('\n');

  // Limit line count to prevent hangs on degenerate input
  if (lines.length > MAX_LINES) return { signature: null, reason: `file exceeds ${MAX_LINES} lines` };

  const escaped = escapeRegex(symbolName);
  // Match only symbol definitions, not references or usage sites.
  // Covers: function/class/const/let/var/interface/type AND class method definitions
  // like 'async login(...) {' or 'login(data) {' which lack a keyword prefix.
  const keywordRegex = new RegExp(
    `(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|class)\\s+${escaped}\\b` +
    `|(?:export\\s+(?:default\\s+)?)?(?:const|let|var)\\s+${escaped}\\b\\s*=` +
    `|\\binterface\\s+${escaped}\\b` +
    `|\\btype\\s+${escaped}\\b\\s*=`,
  );
  // Match method-like definitions: name( ... ) { or name( ... ) :
  // Use bracket-counting to handle nested parentheses in parameters
  const methodRegex = new RegExp(`(?:async\\s+)?${escaped}\\s*\\(`);

  for (const line of lines) {
    const trimmed = line.trim();
    if (keywordRegex.test(trimmed)) {
      // For 'function' declarations: skip overload signatures that end with
      // ';' (e.g., `async function login(a: string): Promise<void>;`) to find
      // the actual implementation line instead.
      if (trimmed.includes('function')) {
        const parenIdx = trimmed.indexOf('(');
        if (parenIdx >= 0) {
          const closeParen = findMatchingClose(trimmed, parenIdx);
          if (closeParen >= 0) {
            const after = trimmed.slice(closeParen + 1).trimStart();
            if (!after.startsWith('{') && !after.startsWith(':')) {
              continue; // no body follows — overload declaration, skip
            }
            if (after.endsWith(';')) {
              continue; // overload declaration ending with ; — skip
            }
          }
        }
      }
      return { signature: trimmed };
    }
    const mStart = methodRegex.exec(trimmed);
    if (mStart) {
      const parenStart = mStart.index + mStart[0].length - 1; // position of '('
      const closing = findMatchingClose(trimmed, parenStart);
      if (closing >= 0 && closing < trimmed.length - 1) {
        const after = trimmed.slice(closing + 1).trimStart();
        if (after.startsWith('{') || after.startsWith(':')) {
          return { signature: trimmed };
        }
      }
    }
  }
  return { signature: null, reason: 'symbol definition not found in source file' };
}

/** Find the index of the closing ) matching the open-paren at `openIdx`. */
function findMatchingClose(str: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
