// src/discovery/auto-linker.ts — Zero-annotation symbol↔doc-section auto-linking
import type Database from 'better-sqlite3';
import type { SymbolRow } from '../db/symbols.js';
import type { ParsedDocSection } from './doc-parser.js';
import { createMapping } from '../db/mappings.js';
import { docSectionId } from '../utils/hash.js';
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

  return { confidence: 0, matched: false };
}

// ── Main autoLink function ───────────────────────────────────────────────────

export function autoLink(
  db: Database.Database,
  symbols: SymbolRow[],
  docSections: ParsedDocSection[],
  minConfidence: number = 0.5,
): AutoLinkResult {
  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error(`minConfidence must be between 0.0 and 1.0, got ${minConfidence}`);
  }

  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;

  // Build a set of existing mappings for fast skip check.
  // Key: "symbol_id::doc_id::rel_type"
  const existingKeys = new Set<string>();
  const existingRows = db.prepare(
    'SELECT symbol_id, doc_id, rel_type FROM mappings'
  ).all() as Array<{ symbol_id: string; doc_id: string; rel_type: string }>;
  for (const row of existingRows) {
    existingKeys.add(`${row.symbol_id}::${row.doc_id}::${row.rel_type}`);
  }

  const MAX_COMPARISONS = 1_000_000;
  const AUTO_LINK_TIMEOUT_MS = 30_000;
  const startTime = Date.now();
  let comparisons = 0;
  let timedOut = false;

  for (const symbol of symbols) {
    if (timedOut) break;
    for (const section of docSections) {
      comparisons++;
      if (comparisons > MAX_COMPARISONS) {
        console.warn(`DocRel: autoLink exceeded ${MAX_COMPARISONS} comparisons — aborting. Remaining symbols/sections skipped.`);
        timedOut = true;
        break;
      }
      if (Date.now() - startTime > AUTO_LINK_TIMEOUT_MS) {
        console.warn(`DocRel: autoLink timed out after ${AUTO_LINK_TIMEOUT_MS}ms — returning partial results.`);
        timedOut = true;
        break;
      }

      const score = scorePair(symbol, section, minConfidence);
      if (!score.matched) continue;

      const docId = docSectionId(section.file, section.anchor);
      if (!docId) continue;

      const mappingKey = `${symbol.id}::${docId}::describes`;
      if (existingKeys.has(mappingKey)) continue; // skip duplicates

      try {
        createMapping(db, {
          symbol_id: symbol.id,
          doc_id: docId,
          rel_type: 'describes',
          review_status: 'auto',
        });
        existingKeys.add(mappingKey);

        if (score.confidence >= 0.8) {
          highConfidence++;
        } else if (score.confidence >= 0.5) {
          mediumConfidence++;
        } else {
          lowConfidence++;
        }
      } catch {
        // UNIQUE constraint or other DB error — skip
      }
    }
  }

  return {
    totalMatched: highConfidence + mediumConfidence + lowConfidence,
    highConfidence,
    mediumConfidence,
    lowConfidence,
  };
}
