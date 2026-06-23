// src/sync/engine.ts
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { assertDbOpen } from '../db/connection.js';
import type { DocRelConfig } from '../utils/config.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getSymbol } from '../db/symbols.js';
import { getDocSection, markDocStale, markDocSynced, markDocSyncedWithHash } from '../db/docs.js';
import { contentHash } from '../utils/hash.js';
import { updateInlineDoc, extractDocstring, generateUpdatedDocstring } from './inline.js';
import { stripCommentsAndStrings, stripAllBlockComments } from './inline.js';
import { findSectionContent } from './standalone.js';
import { updateGeneratedDoc, detectGenerator } from './generated.js';

export interface SyncResult {
  symbolId: string;
  docsUpdated: string[];
  docsStaled: string[];
  docsChecked: string[];
  errors: string[];
  warnings: string[];
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
  if (!file || isNaN(line) || line < 0) return null;
  return { file, line };
}

export async function syncSymbol(
  db: Database.Database,
  config: DocRelConfig,
  symbolId: string,
  projectRoot: string,
): Promise<SyncResult> {
  const result: SyncResult = { symbolId, docsUpdated: [], docsStaled: [], docsChecked: [], errors: [], warnings: [] };

  try {
    assertDbOpen(db);
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
      if (!strategy) {
        console.warn(`DocRel: No strategy configured for doc_type '${doc.doc_type}' — marking doc ${doc.id} as stale`);
        if (markDocStale(db, doc.id)) {
          result.docsStaled.push(doc.file);
        } else {
          result.errors.push(`Failed to mark doc ${doc.id} as stale — doc may have been deleted concurrently`);
        }
        continue;
      }

      try {
        switch (doc.doc_type) {
        case 'inline': {
          const loc = parseLocation(symbol.location);
          if (!loc) {
            result.errors.push(`Cannot sync inline docs for ${symbol.name}: invalid or missing source file location`);
            continue;
          }
          // If the symbol's source file differs from the doc's registered file,
          // warn and use the symbol's actual location (which is what gets modified).
          // Normalize both paths to avoid false mismatches from differing formats
          // (e.g., src/foo.ts vs ./src/foo.ts or inconsistent slash direction).
          if (path.normalize(loc.file) !== path.normalize(doc.file)) {
            result.warnings.push(`Inline doc for ${symbol.name}: repaired file mismatch — updated doc_sections.file from ${relPath(doc.file, projectRoot)} to ${relPath(loc.file, projectRoot)}`);
            // Reset both content_hash and status so the doc is re-evaluated.
            // Clearing content_hash alone relies on a subsequent scan to detect
            // the change; resetting status ensures the doc is re-synced regardless.
            db.prepare("UPDATE doc_sections SET file = ?, content_hash = '', status = 'stale', updated_at = datetime('now') WHERE id = ?").run(loc.file, doc.id);
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
            const newDocstring = generateUpdatedDocstring(symbol.name, symbol.kind, oldDocstring, newSig);

            // Extract current signature from the source to use as oldSignature.
            // If extraction fails (signature is null), skip the updateInlineDoc
            // call entirely to avoid wasted I/O (file open, read, comment stripping,
            // and occurrence counting with empty oldSignature).
            const extractResult = extractCurrentSignature(loc.file, symbol.name, projectRoot);
            if (extractResult.signature === null) {
              result.errors.push(`Failed to update inline doc for ${symbol.name} in ${relPath(loc.file, projectRoot)}: ${extractResult.reason ?? 'could not extract current signature'}`);
              continue;
            }
            const oldSig = extractResult.signature;

            const updated = updateInlineDoc({
              file: loc.file,
              symbolName: symbol.name,
              oldSignature: oldSig,
              newSignature: newSig,
              oldDocstring,
              newDocstring,
            }, projectRoot);

            if (updated) {
              if (markDocSynced(db, doc.id)) {
                result.docsUpdated.push(loc.file);
              } else {
                result.errors.push(`Failed to mark inline doc ${doc.id} as synced — doc may have been deleted concurrently`);
              }
            } else {
              result.errors.push(`Failed to update inline doc for ${symbol.name} in ${relPath(loc.file, projectRoot)}`);
            }
          } else {
            if (markDocStale(db, doc.id)) {
              result.docsStaled.push(doc.file);
            } else {
              result.errors.push(`Failed to mark inline doc ${doc.id} as stale — doc may have been deleted concurrently`);
            }
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
                // Atomically update both content_hash and status in a single
                // UPDATE to prevent a crash between the two from leaving the
                // doc in a permanently stale state (hash updated, status stale).
                const ok = markDocSyncedWithHash(db, doc.id, newHash);
                if (!ok) {
                  result.errors.push(`Standalone doc section ${doc.id} not found — race condition?`);
                } else {
                  result.docsUpdated.push(doc.file);
                }
              } else if (doc.status === 'stale') {
                // Content already reflects the code change — transition back
                // to in_sync so the doc does not remain permanently stale.
                // HOWEVER, only do this when the file's mtime is newer than
                // doc.updated_at — if the agent encountered an error and made
                // no changes, the content on disk may still be stale.
                // updated_at reflects when the doc was last marked stale;
                // a newer mtime means the file was genuinely rewritten.
                let fileModified = false;
                const resolvedPath = validatePath(doc.file, projectRoot);
                if (resolvedPath) {
                  try {
                    const st = fs.statSync(resolvedPath);
                    // doc.updated_at uses space-separated format from SQLite
                    // datetime('now'). Replace space with 'T' for valid
                    // ISO 8601 per ECMAScript spec (Date.parse requires T).
                    const docDate = new Date(doc.updated_at.replace(' ', 'T') + 'Z').getTime();
                    fileModified = st.mtimeMs > docDate;
                  } catch { /* stat failed — do not transition */ }
                }
                if (fileModified) {
                  if (markDocSynced(db, doc.id)) {
                    result.docsChecked.push(doc.file);
                  } else {
                    result.errors.push(`Failed to mark standalone doc ${doc.id} as synced — doc may have been deleted concurrently`);
                  }
                }
              }
            } else {
              result.errors.push(`Cannot find section '${doc.anchor}' in ${relPath(doc.file, projectRoot)} — doc may have been restructured`);
              if (markDocStale(db, doc.id)) {
                result.docsStaled.push(doc.file);
              } else {
                result.errors.push(`Failed to mark standalone doc ${doc.id} as stale — doc may have been deleted concurrently`);
              }
            }
          } else if (strategy === 'mark_stale') {
            if (markDocStale(db, doc.id)) {
              result.docsStaled.push(doc.file);
            } else {
              result.errors.push(`Failed to mark standalone doc ${doc.id} as stale — doc may have been deleted concurrently`);
            }
          } else if (strategy === 'prompt') {
            // 'prompt' is a documented strategy for manual review — treat as
            // a warning rather than an error to avoid polluting sync results.
            result.warnings.push(`Standalone doc ${relPath(doc.file, projectRoot)}: 'prompt' strategy requires manual review. Docs will not be auto-synced.`);
            result.docsChecked.push(doc.file);
          }
          break;
        }

        case 'generated': {
          if (strategy === 'auto_update') {
            const generator = detectGenerator(doc.file, projectRoot);
            if (generator) {
              const genResult = updateGeneratedDoc({ file: doc.file, generator, projectRoot });
              if (genResult.success) {
                if (markDocSynced(db, doc.id)) {
                  result.docsUpdated.push(doc.file);
                } else {
                  result.errors.push(`Failed to mark generated doc ${doc.id} as synced — doc may have been deleted concurrently`);
                }
              } else {
                result.errors.push(`Failed to regenerate ${relPath(doc.file, projectRoot)}: ${genResult.output}`);
              }
            } else {
              result.errors.push(`No generator found for ${relPath(doc.file, projectRoot)}. Marking as stale.`);
              if (markDocStale(db, doc.id)) {
                result.docsStaled.push(doc.file);
              } else {
                result.errors.push(`Failed to mark generated doc ${doc.id} as stale — doc may have been deleted concurrently`);
              }
            }
          } else {
            if (markDocStale(db, doc.id)) {
              result.docsStaled.push(doc.file);
            } else {
              result.errors.push(`Failed to mark generated doc ${doc.id} as stale — doc may have been deleted concurrently`);
            }
          }
          break;
        }

        case 'architecture': {
          if (strategy !== 'ignore') {
            if (markDocStale(db, doc.id)) {
              result.docsStaled.push(doc.file);
            } else {
              result.errors.push(`Failed to mark architecture doc ${doc.id} as stale — doc may have been deleted concurrently`);
            }
          }
          break;
        }

        default:
          result.errors.push(`Unknown doc_type '${doc.doc_type}' for doc ${doc.id} — cannot sync`);
      }
    } catch (err: any) {
      // Log only the doc_id (SHA-256 hash), not the raw error which may
      // contain absolute paths. Process supervisors (Docker, systemd) may
      // capture stderr.
      console.error(`DocRel: Error syncing doc ${mapping.doc_id}`);
      result.errors.push(`Error syncing doc ${mapping.doc_id}: internal error — check server logs`);
    }
  }
  } catch (err: any) {
    console.error(`DocRel: Catastrophic sync error for ${symbolId}:`, err);
    result.errors.push(`Catastrophic sync error: internal error — check server logs`);
  }

  return result;
}

const MAX_LINES = 100_000;

import { escapeRegex, validatePath } from '../utils/fs.js';
import path from 'node:path';

/** Ensure a file path is relative to projectRoot in error messages.
 *  DB-stored paths are already relative but this provides defense-in-depth
 *  against accidentally storing or leaking absolute paths. */
function relPath(p: string, root: string): string {
  if (p.startsWith(root)) return path.relative(root, p);
  // Already relative — ensure root-relative marker for clarity
  return p.startsWith('.') ? p : `./${p}`;
}

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
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { signature: null, reason: 'not a regular file' };
    if (stat.size > 10 * 1024 * 1024) return { signature: null, reason: 'file exceeds 10 MB size limit' };
    content = fs.readFileSync(fd, 'utf-8');
  } catch {
    return { signature: null, reason: 'could not read source file' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
  const lines = content.split('\n');

  // Pre-process the full file content with stripAllBlockComments to prevent
  // false positives from function/method definitions inside multi-line /* */
  // block comments. Without this, before the per-line loop, commented-out
  // old implementations could match the regex and be returned as the
  // signature, causing updateInlineDoc to receive a wrong oldSignature.
  const processedContent = stripAllBlockComments(content);
  const processedLines = processedContent.split('\n');

  // Limit line count to prevent hangs on degenerate input
  if (processedLines.length > MAX_LINES) return { signature: null, reason: `file exceeds ${MAX_LINES} lines` };

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
  const methodRegex = new RegExp(`(?:async\\s+)?\\b${escaped}\\s*\\(`);

  for (let i = 0; i < processedLines.length; i++) {
    const line = processedLines[i];
    const trimmed = line.trim();
    // Strip comments and strings before matching keywords to prevent
    // false positives from symbol names appearing inside string literals
    // (e.g., const x = 'function login(a: string): User;') or comments.
    const codeOnly = stripCommentsAndStrings(trimmed);
    if (keywordRegex.test(codeOnly)) {
      // For 'function' declarations: skip overload signatures that end with
      // ';' (e.g., `async function login(a: string): Promise<void>;`) to find
      // the actual implementation line instead.
      if (trimmed.includes('function')) {
        const parenIdx = trimmed.indexOf('(');
        if (parenIdx >= 0) {
          let closeParen = findMatchingClose(trimmed, parenIdx);
          // If closing paren is not on this line, read subsequent lines to
          // build a multi-line signature (e.g., async function login(\n  user: string\n): Promise<User>) .
          let multiLineSig = trimmed;
          let lineIdx = i;
          while (closeParen < 0 && lineIdx + 1 < processedLines.length) {
            lineIdx++;
            multiLineSig += '\n' + processedLines[lineIdx];
            closeParen = findMatchingClose(multiLineSig, parenIdx);
          }
          if (closeParen >= 0) {
            const after = multiLineSig.slice(closeParen + 1).trimStart();
            if (!after.startsWith('{') && !after.startsWith(':')) {
              continue; // no body follows — overload declaration, skip
            }
            if (after.endsWith(';')) {
              continue; // overload declaration ending with ; — skip
            }
            return { signature: multiLineSig.trim() };
          }
        }
      }
      // For const/let/var patterns: if the line has an opening paren with no
      // matching close, accumulate multi-line signature (e.g. arrow functions
      // with multi-line parameter lists).
      const parenIdx2 = trimmed.indexOf('(');
      if (parenIdx2 >= 0 && findMatchingClose(trimmed, parenIdx2) < 0) {
        let multiLineSig2 = trimmed;
        let lineIdx2 = i;
        let closeParen2 = -1;
        while (closeParen2 < 0 && lineIdx2 + 1 < processedLines.length) {
          lineIdx2++;
          multiLineSig2 += '\n' + processedLines[lineIdx2];
          closeParen2 = findMatchingClose(multiLineSig2, parenIdx2);
        }
        if (closeParen2 >= 0) {
          return { signature: multiLineSig2.trim() };
        }
      }
      return { signature: trimmed };
    }
    // Test method regex against codeOnly to avoid matching inside comments/strings.
    // If it matches, run exec against the original trimmed to get the correct
    // index position for the parenthesis tracking.
    const mStart = methodRegex.exec(codeOnly);
    if (mStart) {
      // Re-run against the original trimmed to get correct positional info
      const realStart = methodRegex.exec(trimmed);
      if (realStart) {
        const parenStart = realStart.index + realStart[0].length - 1; // position of '('
        let closing = findMatchingClose(trimmed, parenStart);
        // Build multi-line signature if closing paren is not on this line
        let multiLineSig = trimmed;
        let lineIdx = i;
        while (closing < 0 && lineIdx + 1 < processedLines.length) {
          lineIdx++;
          multiLineSig += '\n' + processedLines[lineIdx];
          closing = findMatchingClose(multiLineSig, parenStart);
        }
        if (closing >= 0 && closing < multiLineSig.length - 1) {
          const after = multiLineSig.slice(closing + 1).trimStart();
          if (after.startsWith('{') || after.startsWith(':')) {
            if (after.endsWith(';')) continue;  // overload/interface declaration
            return { signature: multiLineSig.trim() };
          }
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
