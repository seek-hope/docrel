// src/discovery/auto-linker.ts — Zero-annotation symbol↔doc-section auto-linking
import type Database from 'better-sqlite3';
import type { SymbolRow } from '../db/symbols.js';
import type { ParsedDocSection } from './doc-parser.js';
import { createMapping } from '../db/mappings.js';
import { upsertDocSection } from '../db/docs.js';
import { docSectionId, contentHash } from '../utils/hash.js';
import { escapeRegex } from '../utils/fs.js';

export interface AutoLinkResult {
  totalMatched: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
}

// ── Normalization helpers ────────────────────────────────────────────────────

/** Lowercase and strip non-alphanumeric characters for fuzzy comparison. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Check if `haystack` contains `needle` as a case-insensitive substring. */
function containsIgnoreCase(needle: string, haystack: string): boolean {
  if (!needle || !haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Check if `needle` is a fuzzy substring of `haystack` (case-insensitive). */
function isFuzzySubstring(needle: string, haystack: string): boolean {
  const n = normalize(needle);
  const h = normalize(haystack);
  if (!n || !h) return false;
  // Direct containment
  if (h.includes(n) || n.includes(h)) return true;
  // Significant prefix overlap (at least 4 chars or 60% of the shorter string)
  const minLen = Math.min(n.length, h.length);
  const prefixThreshold = Math.max(4, Math.floor(minLen * 0.6));
  let matchLen = 0;
  for (let i = 0; i < minLen && n[i] === h[i]; i++) {
    matchLen++;
  }
  if (matchLen >= prefixThreshold) return true;
  // F9: Add longest common substring check to catch mid-string and suffix
  // overlaps (e.g., 'loginUser' vs 'userLogin' share 'user' in the middle).
  // Require at least 4 chars or 50% of the shorter string.
  const lcsLen = longestCommonSubstring(n, h);
  const lcsThreshold = Math.max(4, Math.floor(minLen * 0.5));
  return lcsLen >= lcsThreshold;
}

/** Compute the length of the longest common substring of a and b. */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let maxLen = 0;
  // Use a 1D DP array for O(n*m) time, O(min(n,m)) space
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const dp = new Uint16Array(shorter.length + 1);
  for (let i = 1; i <= longer.length; i++) {
    let prev = 0;
    for (let j = 1; j <= shorter.length; j++) {
      const temp = dp[j];
      if (longer[i - 1] === shorter[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > maxLen) maxLen = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = temp;
    }
  }
  return maxLen;
}

// ── File-name helper ─────────────────────────────────────────────────────────

/** Strip file extension and normalize path separators. */
function fileStem(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const noExt = lastDot > filePath.lastIndexOf('/') ? filePath.slice(0, lastDot) : filePath;
  return noExt.toLowerCase().replace(/[\/\\]+/g, '');
}

// ── Confidence scoring ───────────────────────────────────────────────────────

interface ScoreResult {
  confidence: number;
  matched: boolean;
}

/**
 * Compute the highest confidence score for a symbol↔doc-section pair.
 * Returns { confidence, matched } where matched=true when confidence >= minConfidence.
 */
function scorePair(
  symbol: SymbolRow,
  section: ParsedDocSection,
  minConfidence: number,
): ScoreResult {
  const symName = symbol.name;
  const symNameClean = symName.replace(/\(.*\)$/, ''); // strip "login()" → "login"
  const heading = section.anchor || '';
  const content = section.content || '';

  // 1. Exact word match in heading (confidence 1.0).
  // Use word-boundary regex to prevent substring matches like symbol 'get'
  // matching heading 'Getting Started' or 'a' matching any heading.
  // Left side uses (?:^|\b) so symbols starting with non-word chars (e.g.
  // $special_fn) still match at the start of the heading.
  if (heading.length > 0) {
    const wordBoundaryRe = new RegExp('(?:^|\\b)' + escapeRegex(symNameClean) + '(?:\\b|$)', 'i');
    if (wordBoundaryRe.test(heading)) {
      return { confidence: 1.0, matched: 1.0 >= minConfidence };
    }
    // 1b. Substring match in heading (confidence 0.7) — weaker signal,
    // catches partial-name matches like 'getUser' in 'getUserProfile'.
    if (containsIgnoreCase(symNameClean, heading) && symNameClean.length >= 3) {
      return { confidence: 0.7, matched: 0.7 >= minConfidence };
    }
  }

  // 2. Backtick match (confidence 0.9) — CodeRef with refType 'backtick'
  for (const ref of (section.codeRefs ?? [])) {
    if (ref.refType === 'backtick') {
      const refClean = ref.symbolName.replace(/\(.*\)$/, '');
      if (refClean === symNameClean ||
          refClean === symName ||
          ref.symbolName === symName ||
          ref.symbolName === symNameClean) {
        return { confidence: 0.9, matched: 0.9 >= minConfidence };
      }
    }
  }

  // 3. Code block match (confidence 0.7) — CodeRef with refType 'codeblock'
  for (const ref of (section.codeRefs ?? [])) {
    if (ref.refType === 'codeblock') {
      const refClean = ref.symbolName.replace(/\(.*\)$/, '');
      if (refClean === symNameClean ||
          refClean === symName ||
          ref.symbolName === symName ||
          ref.symbolName === symNameClean) {
        return { confidence: 0.7, matched: 0.7 >= minConfidence };
      }
    }
  }

  // 4. Fuzzy heading match (confidence 0.6)
  if (heading.length > 0 && isFuzzySubstring(symNameClean, heading)) {
    return { confidence: 0.6, matched: 0.6 >= minConfidence };
  }

  // Also check fuzzy match on heading via CodeRef type 'heading'
  for (const ref of (section.codeRefs ?? [])) {
    if (ref.refType === 'heading') {
      const refClean = ref.symbolName.replace(/\(.*\)$/, '');
      if (refClean === symNameClean || ref.symbolName === symName ||
          isFuzzySubstring(symNameClean, ref.symbolName)) {
        return { confidence: 0.6, matched: 0.6 >= minConfidence };
      }
    }
  }

  // 5. File-name convention (confidence 0.5)
  // Doc file name matches symbol namespace — e.g. docs/auth.md ↔ src/auth.ts
  const symLocation = (symbol.location || '').toLowerCase().replace(/\\/g, '/');
  const docFile = section.file.toLowerCase().replace(/\\/g, '/');
  if (symLocation && docFile) {
    const symFileStem = fileStem(symLocation.split('/').pop() || symLocation);
    const docFileStem = fileStem(docFile.split('/').pop() || docFile);
    if (symFileStem === docFileStem && symFileStem.length > 0) {
      return { confidence: 0.5, matched: 0.5 >= minConfidence };
    }
  }

  // 6. Body-text word match (confidence 0.4) — for identifiers that appear
  // in running text without backticks or code markup. Only match identifiers
  // that look like code symbols (CamelCase, PascalCase, snake_case) to avoid
  // false positives on common English words like 'get', 'set', 'data'.
  // Minimum 4 characters — shorter names are overwhelmingly false positives.
  if (symNameClean.length >= 4 && isCodeLikeIdentifier(symNameClean)) {
    const wordBoundaryRe = new RegExp('(?:^|\\b)' + escapeRegex(symNameClean) + '(?:\\b|$)', 'i');
    if (wordBoundaryRe.test(content) || wordBoundaryRe.test(heading)) {
      return { confidence: 0.4, matched: 0.4 >= minConfidence };
    }
  }

  return { confidence: 0, matched: false };
}

/** Check if a symbol name looks like a code identifier rather than a common
 *  English word. Matches CamelCase, PascalCase, or snake_case names.
 *  All-lowercase single words (even long ones like 'authentication') are
 *  rejected — they produce too many false positives in body-text matching. */
function isCodeLikeIdentifier(name: string): boolean {
  // CamelCase/PascalCase: at least one uppercase letter
  if (/[A-Z]/.test(name)) return true;
  // snake_case: underscore with letters on both sides
  if (/[a-zA-Z]_[a-zA-Z]/.test(name)) return true;
  // Leading underscore (e.g., _privateMethod)
  if (name.startsWith('_') && name.length > 1) return true;
  return false;
}

// ── Fast pass-1 scoring ──────────────────────────────────────────────────────

/**
 * Fast scoring for pass 1: only checks exact matches (heading word boundary
 * and backtick exact match). These are the highest-confidence rules and are
 * cheap to compute. Returns confidence (1.0, 0.9) or 0 if no match.
 */
function fastScorePair(symbol: SymbolRow, section: ParsedDocSection): number {
  const symName = symbol.name;
  const symNameClean = symName.replace(/\(.*\)$/, '');
  const heading = section.anchor || '';

  // 1. Exact word match in heading (confidence 1.0)
  if (heading.length > 0) {
    const wordBoundaryRe = new RegExp('(?:^|\\b)' + escapeRegex(symNameClean) + '(?:\\b|$)', 'i');
    if (wordBoundaryRe.test(heading)) {
      return 1.0;
    }
  }

  // 2. Backtick match (confidence 0.9)
  for (const ref of (section.codeRefs ?? [])) {
    if (ref.refType === 'backtick') {
      const refClean = ref.symbolName.replace(/\(.*\)$/, '');
      if (refClean === symNameClean ||
          refClean === symName ||
          ref.symbolName === symName ||
          ref.symbolName === symNameClean) {
        return 0.9;
      }
    }
  }

  return 0;
}

/** Create a mapping and update confidence counters. Returns true on success. */
function tryCreateMapping(
  db: Database.Database,
  symbol: SymbolRow,
  docId: string,
  confidence: number,
  existingKeys: Set<string>,
  counters: { high: number; medium: number; low: number },
): boolean {
  const mappingKey = `${symbol.id}::${docId}::describes`;
  if (existingKeys.has(mappingKey)) return false;

  try {
    createMapping(db, {
      symbol_id: symbol.id,
      doc_id: docId,
      rel_type: 'describes',
      review_status: 'auto',
    });
    existingKeys.add(mappingKey);

    if (confidence >= 0.8) {
      counters.high++;
    } else if (confidence >= 0.5) {
      counters.medium++;
    } else {
      counters.low++;
    }
    return true;
  } catch (err: any) {
    // UNIQUE constraint is expected when a mapping already exists — skip silently.
    // For all other errors (SQLITE_CORRUPT, SQLITE_READONLY, SQLITE_FULL, SQLITE_IOERR),
    // log a warning so operators can detect hardware or database failures.
    if ((err as any)?.code?.startsWith('SQLITE_CONSTRAINT')) {
      // expected — mapping already exists, skip
    } else {
      console.warn('DocSync: autoLink createMapping failed:', err instanceof Error ? err.message : err);
    }
    return false;
  }
}

/** Compute the doc ID for a section, logging a warning on failure. */
function tryDocSectionId(section: ParsedDocSection): string | null {
  const docId = docSectionId(section.file, section.anchor);
  if (!docId) {
    console.warn(`DocSync: autoLink — could not compute docSectionId for ${section.file}#${section.anchor}`);
  }
  return docId || null;
}

// ── Main autoLink function (two-pass) ────────────────────────────────────────

export function autoLink(
  db: Database.Database,
  symbols: SymbolRow[],
  docSections: ParsedDocSection[],
  minConfidence: number = 0.5,
): AutoLinkResult {
  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error(`minConfidence must be between 0.0 and 1.0, got ${minConfidence}`);
  }

  const counters = { high: 0, medium: 0, low: 0 };

  // Build a set of existing mappings for fast skip check.
  // Key: "symbol_id::doc_id::rel_type"
  const existingKeys = new Set<string>();
  const existingRows = db.prepare(
    'SELECT symbol_id, doc_id, rel_type FROM mappings'
  ).all() as Array<{ symbol_id: string; doc_id: string; rel_type: string }>;
  for (const row of existingRows) {
    existingKeys.add(`${row.symbol_id}::${row.doc_id}::${row.rel_type}`);
  }

  const AUTO_LINK_TIMEOUT_MS = 30_000;
  const startTime = Date.now();
  const timedOut = () => Date.now() - startTime > AUTO_LINK_TIMEOUT_MS;

  // Symbols that already received a high-confidence link in pass 1.
  // These are skipped in pass 2 to avoid low-confidence false positives.
  const linkedSymbolIds = new Set<string>();

  // ── Pass 1: Exact matches only (heading word boundary + backtick) ──────
  // This pass is O(symbols × sections) but each comparison is cheap (no
  // fuzzy substring, no codeRef iteration beyond backtick). For a 2000×500
  // project (1M pairs), pass 1 runs in under a second.

  for (const symbol of symbols) {
    if (timedOut()) {
      console.warn(`DocSync: autoLink timed out after ${AUTO_LINK_TIMEOUT_MS}ms during pass 1 — returning partial results.`);
      return {
        totalMatched: counters.high + counters.medium + counters.low,
        highConfidence: counters.high,
        mediumConfidence: counters.medium,
        lowConfidence: counters.low,
      };
    }

    for (const section of docSections) {
      const conf = fastScorePair(symbol, section);
      if (conf === 0) continue;

      const docId = tryDocSectionId(section);
      if (!docId) continue;

      if (tryCreateMapping(db, symbol, docId, conf, existingKeys, counters)) {
        linkedSymbolIds.add(symbol.id);
      }
    }
  }

  // ── Pass 2: Full scoring for unlinked symbols ───────────────────────────
  // Only symbols without any pass-1 link go through the slower fuzzy matching.
  // This is typically a much smaller set, so the expensive isFuzzySubstring
  // calls are bounded to a fraction of the total symbol×section space.

  for (const symbol of symbols) {
    if (linkedSymbolIds.has(symbol.id)) continue;

    if (timedOut()) {
      console.warn(`DocSync: autoLink timed out after ${AUTO_LINK_TIMEOUT_MS}ms during pass 2 — returning partial results.`);
      break;
    }

    for (const section of docSections) {
      const score = scorePair(symbol, section, minConfidence);
      if (!score.matched) continue;

      const docId = tryDocSectionId(section);
      if (!docId) continue;

      tryCreateMapping(db, symbol, docId, score.confidence, existingKeys, counters);
    }
  }

  return {
    totalMatched: counters.high + counters.medium + counters.low,
    highConfidence: counters.high,
    mediumConfidence: counters.medium,
    lowConfidence: counters.low,
  };
}

export interface IngestResult {
  newDocSections: number;
  newMappings: number;
}

/**
 * Ingest parsed doc sections into the database: upsert doc_sections rows and
 * create mappings for code references that match known symbols. This is the
 * shared pipeline used by MCP scan, MCP refresh, CLI scan, and file watcher.
 *
 * Extracted from the 3 duplicate implementations in index.ts (docsync_scan,
 * docsync_refresh) and cli.ts (scan command) — now a single source of truth.
 */
export function ingestDocSections(
  db: Database.Database,
  sections: ParsedDocSection[],
): IngestResult {
  let newDocs = 0;
  let newMappings = 0;

  for (const section of sections) {
    const id = docSectionId(section.file, section.anchor);
    if (!id) continue;

    const hash = contentHash(section.content);
    const existing = db.prepare('SELECT id FROM doc_sections WHERE id = ?').get(id) as { id: string } | undefined;
    upsertDocSection(db, { id, file: section.file, anchor: section.anchor, content_hash: hash, doc_type: 'standalone' });
    if (!existing) newDocs++;

    for (const ref of section.codeRefs) {
      const cleanName = ref.symbolName.replace(/\(.*\)$/, '');
      const matched = db.prepare(
        'SELECT id FROM symbols WHERE name = ? OR name = ? LIMIT 1'
      ).get(cleanName, ref.symbolName) as { id: string } | undefined;

      if (matched) {
        try {
          createMapping(db, {
            symbol_id: matched.id,
            doc_id: id,
            rel_type: 'describes',
            review_status: 'auto',
          });
          newMappings++;
        } catch { /* skip duplicates */ }
      }
    }
  }

  return { newDocSections: newDocs, newMappings };
}
