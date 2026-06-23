// src/discovery/auto-linker.ts — Zero-annotation symbol↔doc-section auto-linking
import type Database from 'better-sqlite3';
import type { SymbolRow } from '../db/symbols.js';
import type { ParsedDocSection } from './doc-parser.js';
import { createMapping } from '../db/mappings.js';
import { docSectionId } from '../utils/hash.js';

export interface AutoLinkResult {
  totalMatched: number;
  highConfidence: number;   // confidence >= 0.8
  mediumConfidence: number; // 0.5–0.8
  lowConfidence: number;    // < 0.5 (needs review)
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
  const threshold = Math.max(4, Math.floor(minLen * 0.6));
  let matchLen = 0;
  for (let i = 0; i < minLen && n[i] === h[i]; i++) {
    matchLen++;
  }
  return matchLen >= threshold;
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

  // 1. Exact name match in heading (confidence 1.0)
  if (heading.length > 0 && containsIgnoreCase(symNameClean, heading)) {
    return { confidence: 1.0, matched: 1.0 >= minConfidence };
  }

  // 2. Backtick match (confidence 0.9) — CodeRef with refType 'backtick'
  for (const ref of section.codeRefs) {
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
  for (const ref of section.codeRefs) {
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
  for (const ref of section.codeRefs) {
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

  for (const symbol of symbols) {
    for (const section of docSections) {
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
          confidence: score.confidence,
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
