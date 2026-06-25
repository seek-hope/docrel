// src/sync/engine.ts
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { assertDbOpen } from '../db/connection.js';
import type { DocRelayConfig } from '../utils/config.js';
import { getMappingsForSymbol, getMappingsForDoc } from '../db/mappings.js';
import type { DocSectionRow } from '../db/docs.js';
import type { CodegraphClient } from '../codegraph/client.js';
import { getSymbol } from '../db/symbols.js';
import { getDocSection, markDocStale, markDocRelayed, markDocRelayedWithHash } from '../db/docs.js';
import { contentHash } from '../utils/hash.js';
import { updateInlineDoc, extractDocstring, generateUpdatedDocstring } from './inline.js';
import { stripCommentsAndStrings, stripAllBlockComments } from './inline.js';
import { findSectionContent } from './standalone.js';
import { updateGeneratedDoc, detectGenerator } from './generated.js';
import { escapeRegex, validatePath } from '../utils/fs.js';
import path from 'node:path';

/** A single proposed change when strategy is 'prompt' — the caller should
 *  present this diff to the user/agent for manual approval. */
export interface ProposedChange {
  file: string;
  anchor?: string;
  reason: string;
  symbolName: string;
}

export interface SyncResult {
  symbolId: string;
  docsUpdated: string[];
  docsStaled: string[];
  docsChecked: string[];
  errors: string[];
  warnings: string[];
  /** When true, at least one doc requires manual review before changes are applied. */
  requiresReview: boolean;
  /** Structured diff of proposed changes that were NOT applied. Caller (CLI/MCP)
   *  should present these to the user/agent for approval. */
  proposedChanges: ProposedChange[];
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

/** Extract the current signature for a symbol. Tries codegraph first
 *  (either cached raw_signature or a fresh query), then falls back to
 *  regex-based source file parsing. */
async function getCurrentSignature(
  symbol: import('../db/symbols.js').SymbolRow,
  codegraph: CodegraphClient | undefined,
  projectRoot: string,
  skipCache = false,
): Promise<{ signature: string | null; reason?: string; source: 'codegraph_raw' | 'codegraph_query' | 'regex' | 'none' }> {
  // 1. Use the cached raw_signature from DB (populated by codegraph during scan),
  //    UNLESS skipCache is true. When called from a sync context after a scan has
  //    already updated raw_signature to the new code value, the cache is stale as
  //    a measure of "current" (file still has the old text). Bypassing forces a
  //    regex-based source file read so oldSig != newSig and updateInlineDoc works.
  if (!skipCache && symbol.raw_signature) {
    return { signature: symbol.raw_signature, source: 'codegraph_raw' };
  }

  // 2. Try a fresh codegraph query
  if (codegraph) {
    try {
      const loc = parseLocation(symbol.location);
      const sig = await codegraph.getSymbolSignature(symbol.name, loc?.file);
      if (sig) {
        return { signature: sig, source: 'codegraph_query' };
      }
    } catch (err: any) {
      // codegraph query failed — fall through to regex.
      // Log at debug level so operators can detect when codegraph is unavailable
      // without spamming production logs on every sync call.
      if (process.env.DOCRELAY_DEBUG === '1' || process.env.DOCRELAY_DEBUG === 'true') {
        console.debug('DocRelay: codegraph getSymbolSignature failed, falling back to regex:', err instanceof Error ? err.message : err);
      }
    }
  }

  // 3. Fall back to regex-based extraction from the source file
  const loc = parseLocation(symbol.location);
  if (!loc) {
    return { signature: null, reason: 'invalid or missing source file location', source: 'none' };
  }
  const result = extractCurrentSignature(loc.file, symbol.name, projectRoot, loc.line - 1);
  return { signature: result.signature, reason: result.reason, source: result.signature ? 'regex' : 'none' };
}

export async function syncSymbol(
  db: Database.Database,
  config: DocRelayConfig,
  symbolId: string,
  projectRoot: string,
  codegraph?: CodegraphClient,
): Promise<SyncResult> {
  const result: SyncResult = { symbolId, docsUpdated: [], docsStaled: [], docsChecked: [], errors: [], warnings: [], requiresReview: false, proposedChanges: [] };

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
        console.warn(`DocRelay: No strategy configured for doc_type '${doc.doc_type}' — marking doc ${doc.id} as stale`);
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
            const oldDocstring = extractDocstring(loc.file, symbol.name, projectRoot, loc.line - 1);
            // F1: If extractDocstring returns null (symbol not found in file,
            // file unreadable, regex mismatch), skip the inline sync instead of
            // converting null to '' with ?? ''. Converting to empty string and
            // passing it to generateUpdatedDocstring would produce a minimal
            // placeholder docstring, silently destroying hand-written JSDoc.
            if (oldDocstring === null) {
              result.warnings.push(`Could not extract existing docstring for ${symbol.name} — skipping inline sync to avoid data loss`);
              continue;
            }
            // Skip non-JSDoc files (Python, Go, Rust) — generateUpdatedDocstring
            // produces JSDoc /** ... */ output, which would replace language-specific
            // docstrings ("""...""", // comments, /// comments) and corrupt the file.
            const ext = path.extname(loc.file).toLowerCase();
            if (ext === '.py' || ext === '.pyi' || ext === '.go' || ext === '.rs') {
              result.warnings.push(`Skipped inline sync for ${symbol.name} — non-JSDoc file type (${ext}) not supported for auto_update. Use mark_stale strategy instead.`);
              continue;
            }
            // Use raw_signature (human-readable) for JSDoc generation, not the hash.
            // If raw_signature is empty, the symbol was created without a raw signature
            // (e.g. manual creation or corrupted state) — we cannot generate meaningful docs.
            if (!symbol.raw_signature) {
              result.errors.push(`Skipped inline sync for ${symbol.name}: symbol has no raw signature (DB may be corrupted)`);
              continue;
            }
            const newSig = symbol.raw_signature;
            const newDocstring = generateUpdatedDocstring(symbol.name, symbol.kind, oldDocstring, newSig);

            // Get current signature — skip the raw_signature cache (passed as
            // skipCache=true) because a prior scan may have already updated
            // symbol.raw_signature to the new value. Using the cache would
            // make oldSig === newSig, causing updateInlineDoc to fail.
            const sigResult = await getCurrentSignature(symbol, codegraph, projectRoot, true);
            if (sigResult.signature === null) {
              result.errors.push(`Failed to update inline doc for ${symbol.name} in ${relPath(loc.file, projectRoot)}: ${sigResult.reason ?? 'could not extract current signature'}`);
              continue;
            }
            const oldSig = sigResult.signature;

            const updated = updateInlineDoc({
              file: loc.file,
              symbolName: symbol.name,
              oldSignature: oldSig,
              newSignature: newSig,
              oldDocstring,
              newDocstring,
            }, projectRoot);

            if (updated) {
              if (markDocRelayed(db, doc.id)) {
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
                const ok = markDocRelayedWithHash(db, doc.id, newHash);
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
                    // SQLite datetime('now') returns a UTC string like
                    // '2024-01-15 10:30:00' with no timezone indicator.
                    // new Date() parses this as LOCAL time, causing a skew of
                    // up to +/-12 hours. Force UTC by inserting 'T' and
                    // appending 'Z' so the comparison against st.mtimeMs (UTC)
                    // is timezone-correct.
                    const docMs = new Date(doc.updated_at.replace(' ', 'T') + 'Z').getTime();
                    // Reject epoch-0 (empty string or Jan 1 1970) and negative
                    // dates which indicate a corrupt or never-set updated_at field.
                    // Without this guard, st.mtimeMs > 0 is always true, incorrectly
                    // transitioning stale docs to in_sync.
                    if (!isNaN(docMs) && docMs > 0) {
                      fileModified = st.mtimeMs > docMs;
                    }
                  } catch (err: any) {
                    const code = (err as NodeJS.ErrnoException)?.code;
                    if (code !== 'ENOENT') {
                      console.warn(`DocRelay: cannot stat ${relPath(doc.file, projectRoot)} for mtime check: ${code}`);
                    }
                  }
                }
                if (fileModified) {
                  if (markDocRelayed(db, doc.id)) {
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
            // Build a structured diff of proposed changes for the caller
            // (CLI or MCP) to present to the user/agent for approval.
            // Changes are NOT applied — the doc remains in its current state.
            result.requiresReview = true;
            result.proposedChanges.push({
              file: doc.file,
              anchor: doc.anchor,
              reason: `Standalone doc section '${doc.anchor}' in ${relPath(doc.file, projectRoot)} is linked to symbol '${symbol.name}' (${symbol.kind}) which may have changed. Manual content review is required.`,
              symbolName: symbol.name,
            });
            result.warnings.push(`Standalone doc ${relPath(doc.file, projectRoot)}: 'prompt' strategy — changes withheld pending manual review.`);
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
                if (markDocRelayed(db, doc.id)) {
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
      // Log the error details for server-side diagnosis, but keep the
      // result.errors message sanitized for MCP/CLI clients.
      // F2: Capture the actual error message (sanitized) in both
      // console.error and result.errors so operators can diagnose failures.
      const msg = err instanceof Error ? err.message : String(err);
      // Sanitize absolute paths from the error message before logging
      const sanitized = msg.replace(/\/[^\s:,)]{20,}/g, '...');
      console.error(`DocRelay: Error syncing doc ${mapping.doc_id}:`, sanitized);
      result.errors.push(`Error syncing doc ${mapping.doc_id}: internal error — check server logs`);
    }
  }
  } catch (err: any) {
    console.error(`DocRelay: Catastrophic sync error for ${symbolId}:`, err);
    result.errors.push(`Catastrophic sync error: internal error — check server logs`);
  }

  return result;
}

export async function syncAllStale(
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelayConfig,
  projectRoot: string,
): Promise<{ synced: SyncResult[]; totalStale: number }> {
  const staleDocs = db.prepare("SELECT * FROM doc_sections WHERE status = 'stale' LIMIT 5000").all() as DocSectionRow[];
  if (staleDocs.length === 0) {
    return { synced: [], totalStale: 0 };
  }

  const uniqueSymbolIds = new Set<string>();
  for (const doc of staleDocs) {
    const mappings = getMappingsForDoc(db, doc.id);
    for (const m of mappings) {
      uniqueSymbolIds.add(m.symbol_id);
    }
  }

  const synced: SyncResult[] = [];
  for (const symbolId of uniqueSymbolIds) {
    synced.push(await syncSymbol(db, config, symbolId, projectRoot, codegraph));
  }

  return { synced, totalStale: staleDocs.length };
}

const MAX_LINES = 100_000;

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
function extractCurrentSignature(file: string, symbolName: string, projectRoot: string, definitionLine?: number): ExtractResult {
  // Use the shared validatePath() for path-traversal defense and dangling
  // symlink detection. This ensures future hardening of validatePath
  // (e.g., TOCTOU hardening, additional checks) propagates here.
  const resolved = validatePath(file, projectRoot);
  if (!resolved) return { signature: null, reason: 'invalid file path or path traversal detected' };

  // F17: Guard against corrupted symbol records with multi-kilobyte names
  // that would produce pathological regex patterns. The symbol name comes from
  // the SQLite database (trusted only to a degree — varchar values can be any
  // length). Mirrors the MAX_ANCHOR_LENGTH (1000) pattern in standalone.ts.
  if (symbolName.length > 500) {
    return { signature: null, reason: 'symbol name too long — possible corruption' };
  }

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
  // Pre-process the full file content with stripAllBlockComments to prevent
  // false positives from function/method definitions inside multi-line /* */
  // block comments. Without this, before the per-line loop, commented-out
  // old implementations could match the regex and be returned as the
  // signature, causing updateInlineDoc to receive a wrong oldSignature.
  const processedContent = stripAllBlockComments(content);
  // Limit line count to prevent hangs on degenerate input.
  // Pre-scan newline count before splitting to avoid OOM from the array
  // allocation itself. (Round 14: the original round 5 fix used a
  // post-split guard which does not prevent the split from allocating.)
  let engineNewlineCount = 1;
  for (let i = 0; i < processedContent.length && engineNewlineCount <= MAX_LINES + 1; i++) {
    if (processedContent[i] === '\n') engineNewlineCount++;
  }
  if (engineNewlineCount > MAX_LINES) return { signature: null, reason: `file exceeds ${MAX_LINES} lines` };
  const processedLines = processedContent.split('\n');

  const escaped = escapeRegex(symbolName);
  // Match only symbol definitions, not references or usage sites.
  // Covers: function/class/const/let/var/interface/type AND class method definitions
  // like 'async login(...) {' or 'login(data) {' which lack a keyword prefix.
  const keywordRegex = new RegExp(
    `(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|class)\\s+${escaped}\\b` +
    `|(?:export\\s+(?:default\\s+)?)?(?:const|let|var)\\s+${escaped}\\b\\s*=` +
    `|\\binterface\\s+${escaped}\\b` +
    `|\\btype\\s+${escaped}\\b(?:<[^>]*>)?\\s*=`,
  );
  // Match method-like definitions: name( ... ) { or name( ... ) :
  // Use bracket-counting to handle nested parentheses in parameters
  const methodRegex = new RegExp(`(?:async\\s+)?\\b${escaped}(?:<[^>]*>)?\\s*\\(`);

  // When a line hint is provided, start searching from that line
  // to find the correct occurrence when same-named symbols share a file.
  const searchStart = (definitionLine !== undefined && definitionLine >= 0 && definitionLine < processedLines.length) ? definitionLine : 0;
  const passes = searchStart > 0
    ? [{ start: searchStart, end: processedLines.length }, { start: 0, end: searchStart }]
    : [{ start: 0, end: processedLines.length }];
  for (const { start, end } of passes) {
    for (let i = start; i < end; i++) {
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
      // Use a word-boundary regex that specifically tests for `function <name>`
      // as a declaration keyword, NOT the substring "function" inside a
      // const/let/var RHS like `const myFn = someFunction(42)`. The old check
      // `trimmed.includes('function')` falsely routed const declarations
      // through the function-overload-detection path, causing those symbols
      // to be skipped entirely.
      const funcDeclPattern = new RegExp(`\\bfunction\\s+${escaped}\\b`);
      if (funcDeclPattern.test(codeOnly)) {
        // Use findParamListOpen to skip angle brackets (<...>) when finding
        // the parameter-list '(' — generic constraints like
        // `function foo<T extends (x: number) => boolean>(param: T)` have
        // parentheses inside the type-parameter brackets that indexOf('(')
        // would misidentify as the parameter list opening.
        const parenIdx = findParamListOpen(trimmed);
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
              // No body on this line — could be an overload (;) or an
              // Allman-style definition where { is on a subsequent line.
              // Peek at the next non-empty line before discarding.
              let peekIdx = lineIdx + 1;
              while (peekIdx < processedLines.length && processedLines[peekIdx].trim() === '') {
                peekIdx++;
              }
              if (peekIdx < processedLines.length) {
                const peekLine = processedLines[peekIdx].trim();
                if (peekLine === '{' || peekLine.startsWith('{')) {
                  // Allman-style body — include intervening lines in signature
                  for (let j = lineIdx + 1; j <= peekIdx; j++) {
                    multiLineSig += '\n' + processedLines[j];
                  }
                  return { signature: multiLineSig.trim() };
                }
              }
              continue; // no body follows — overload declaration, skip
            }
            // Strip inline comments before checking for ';' terminator.
            // An overload declaration like `function foo(): void; // overload`
            // has `after` = `: void; // overload` which does not end with ';'.
            const afterClean = after.replace(/\/\/.*$/, '').trimEnd();
            if (afterClean.endsWith(';')) {
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
    // The codeOnly match confirms a real (non-commented) definition exists on
    // this line. To get the correct position in the original trimmed text,
    // search for the same regex pattern but skip past any preceding /* ... */
    // block comments — the first uncommented match corresponds to codeOnly.
    const mStart = methodRegex.exec(codeOnly);
    if (mStart) {
      // Find the matching occurrence in trimmed, skipping past any preceding
      // block comments that may contain the same symbol-name + paren pattern.
      let searchFrom = 0;
      let parenStart = -1;
      while (searchFrom < trimmed.length) {
        const cand = methodRegex.exec(trimmed.slice(searchFrom));
        if (!cand) break;
        const absIdx = searchFrom + cand.index;
        const before = trimmed.slice(0, absIdx);
        const lastOpen = before.lastIndexOf('/*');
        const lastClose = before.lastIndexOf('*/');
        if (lastOpen <= lastClose) {
          // Not inside a block comment — this is the real occurrence.
          parenStart = absIdx + cand[0].length - 1; // position of '('
          break;
        }
        // This match is inside a block comment. Skip past the comment close.
        const closePos = trimmed.indexOf('*/', lastOpen + 2);
        if (closePos < 0) break; // unclosed block comment — bail out
        searchFrom = closePos + 2;
      }
      if (parenStart >= 0) {
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
            // Strip inline comments before checking for ';' terminator
            // (same issue as the function path at line 518).
            const afterClean = after.replace(/\/\/.*$/, '').trimEnd();
            if (afterClean.endsWith(';')) continue;  // overload/interface declaration
            return { signature: multiLineSig.trim() };
          }
          // No body on this line — peek at the next non-empty line for
          // Allman-style { placement (e.g. method definition with { on its
          // own line after a multi-line parameter list).
          let peekIdx2 = lineIdx + 1;
          while (peekIdx2 < processedLines.length && processedLines[peekIdx2].trim() === '') {
            peekIdx2++;
          }
          if (peekIdx2 < processedLines.length) {
            const peekLine2 = processedLines[peekIdx2].trim();
            if (peekLine2 === '{' || peekLine2.startsWith('{')) {
              for (let j = lineIdx + 1; j <= peekIdx2; j++) {
                multiLineSig += '\n' + processedLines[j];
              }
              return { signature: multiLineSig.trim() };
            }
            // The next non-empty line does not start with { — it may have
            // a return-type annotation before the brace (e.g. "Promise<User> {").
            // Accumulate it and re-check for { so the signature is not lost.
            const extended = multiLineSig + '\n' + processedLines[peekIdx2];
            if (extended.includes('{')) {
              return { signature: extended.trim() };
            }
          }
        } else if (closing >= 0) {
          // closing at end of line (closing == multiLineSig.length - 1) —
          // peek at next non-empty line for Allman-style { body.
          let peekIdx2 = lineIdx + 1;
          while (peekIdx2 < processedLines.length && processedLines[peekIdx2].trim() === '') {
            peekIdx2++;
          }
          if (peekIdx2 < processedLines.length) {
            const peekLine2 = processedLines[peekIdx2].trim();
            if (peekLine2 === '{' || peekLine2.startsWith('{')) {
              for (let j = lineIdx + 1; j <= peekIdx2; j++) {
                multiLineSig += '\n' + processedLines[j];
              }
              return { signature: multiLineSig.trim() };
            }
            // The next non-empty line does not start with { — it may have
            // a return-type annotation before the brace (e.g. "Promise<User> {").
            // Accumulate it and re-check for { so the signature is not lost.
            const extended = multiLineSig + '\n' + processedLines[peekIdx2];
            if (extended.includes('{')) {
              return { signature: extended.trim() };
            }
          }
        }
      }
    }
    }
  }
  return { signature: null, reason: 'symbol definition not found in source file' };
}

/** Find the first '(' that is NOT inside angle brackets (<...>). This
 *  correctly handles generic type parameters that contain function-typed
 *  constraints like `foo<T extends (x: number) => boolean>(param: T)` where
 *  the first '(' belongs to the constraint, not the parameter list.
 *  Mirrors the helper of the same name in inline.ts. */
function findParamListOpen(signature: string): number {
  let angleDepth = 0;
  for (let i = 0; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>' && (i === 0 || signature[i - 1] !== '=')) angleDepth--;
    else if (ch === '(' && angleDepth === 0) return i;
  }
  return -1;
}

/** Find the index of the closing ) matching the open-paren at `openIdx`.
 *  Tracks string and template literals so that a `)` inside a string
 *  (e.g. foo(")")) is not mistaken for the closing parenthesis.
 *  Also tracks `${...}` nesting inside template literals so that nested
 *  backticks (e.g. foo(\`outer ${\`inner\`} tail\`)) do not prematurely
 *  exit the string state. */
function findMatchingClose(str: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  let nestDepth = 0; // ${...} nesting inside template literals
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (inString === '`' && ch === '$' && str[i + 1] === '{') { nestDepth++; continue; }
      if (inString === '`' && ch === '}' && nestDepth > 0) { nestDepth--; continue; }
      if (ch === inString && nestDepth === 0) { inString = null; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
