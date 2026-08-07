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
  /** Candidate pairs that were already mapped before this run (duplicate
   *  skips). Makes re-scans readable: on a fully-linked project totalMatched
   *  is 0 but alreadyLinked shows the pairs that were confirmed as existing. */
  alreadyLinked: number;
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

  // Cumulative confidence from concrete evidence (name/ref matches). The
  // strongest single piece of evidence wins; we then optionally apply a small
  // file-name convention boost on top when *other* evidence already exists.
  let best = 0;

  // 1. Exact word match in heading (confidence 1.0).
  // Use word-boundary regex to prevent substring matches like symbol 'get'
  // matching heading 'Getting Started' or 'a' matching any heading.
  // Left side uses (?:^|\b) so symbols starting with non-word chars (e.g.
  // $special_fn) still match at the start of the heading.
  if (heading.length > 0) {
    const wordBoundaryRe = new RegExp('(?:^|\\b)' + escapeRegex(symNameClean) + '(?:\\b|$)', 'i');
    if (wordBoundaryRe.test(heading)) {
      best = 1.0;
    } else if (containsIgnoreCase(symNameClean, heading) && symNameClean.length >= 3) {
      // 1b. Substring match in heading (confidence 0.7) — weaker signal,
      // catches partial-name matches like 'getUser' in 'getUserProfile'.
      best = Math.max(best, 0.7);
    }
  }

  // Code reference matches, weighted by ref type:
  //   backtick  0.9 — ``name`` / `name()
  //   codeblock 0.7 — inside a fenced code sample
  //   heading   0.6 — symbol captured from a heading token
  //   bodytext  0.4 — bare identifier in prose (weak, e.g. "the login function")
  for (const ref of (section.codeRefs ?? [])) {
    const refClean = ref.symbolName.replace(/\(.*\)$/, '');
    const refEq = refClean === symNameClean ||
      refClean === symName ||
      ref.symbolName === symName ||
      ref.symbolName === symNameClean;

    switch (ref.refType) {
      case 'backtick':
        if (refEq) best = Math.max(best, 0.9);
        break;
      case 'codeblock':
        if (refEq) best = Math.max(best, 0.7);
        break;
      case 'heading':
        // Also allow fuzzy match against a heading-captured ref.
        if (refEq || isFuzzySubstring(symNameClean, ref.symbolName)) best = Math.max(best, 0.6);
        break;
      case 'bodytext':
        // Weak evidence from a bare identifier mentioned in prose. Matches
        // all-lowercase names (e.g. 'login') that other rules reject, but
        // never dominates on its own.
        if (refEq) best = Math.max(best, 0.4);
        break;
      default:
        break;
    }
  }

  // 4. Fuzzy heading match (confidence 0.6)
  if (heading.length > 0 && isFuzzySubstring(symNameClean, heading)) {
    best = Math.max(best, 0.6);
  }

  // 6. Body-text word match (confidence 0.4) — directly scan the section
  // content for identifiers that look like code symbols (CamelCase,
  // PascalCase, snake_case). Minimum 4 characters; all-lowercase names are
  // only reachable via 'bodytext' codeRefs produced by doc-parser so that
  // plain English prose (which is all-lowercase) stays hard to match.
  if (symNameClean.length >= 4 && isCodeLikeIdentifier(symNameClean)) {
    const wordBoundaryRe = new RegExp('(?:^|\\b)' + escapeRegex(symNameClean) + '(?:\\b|$)', 'i');
    if (wordBoundaryRe.test(content) || wordBoundaryRe.test(heading)) {
      best = Math.max(best, 0.4);
    }
  }

  // 5. File-name convention — now a *boost* only, never a standalone match.
  // When the doc file stem equals the symbol's source file stem (e.g.
  // docs/auth.md ↔ src/auth.ts) we raise the confidence of an already-matched
  // pair, but identical stems alone never create a link — that caused massive
  // false positives where every symbol in a file got linked to every section
  // of the same-named doc. +0.1, capped at 1.0.
  const symLocation = (symbol.location || '').toLowerCase().replace(/\\/g, '/');
  const docFile = section.file.toLowerCase().replace(/\\/g, '/');
  if (best > 0 && symLocation && docFile) {
    const symFileStem = fileStem(symLocation.split('/').pop() || symLocation);
    const docFileStem = fileStem(docFile.split('/').pop() || docFile);
    if (symFileStem === docFileStem && symFileStem.length > 0) {
      best = Math.min(1.0, best + 0.1);
    }
  }

  return { confidence: best, matched: best >= minConfidence };
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
  counters: { high: number; medium: number; low: number; alreadyLinked: number },
): boolean {
  const mappingKey = `${symbol.id}::${docId}::describes`;
  if (existingKeys.has(mappingKey)) {
    counters.alreadyLinked++;
    return false;
  }

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
      console.warn('DocRelay: autoLink createMapping failed:', err instanceof Error ? err.message : err);
    }
    return false;
  }
}

/** Compute the doc ID for a section, logging a warning on failure. */
function tryDocSectionId(section: ParsedDocSection): string | null {
  const docId = docSectionId(section.file, section.anchor);
  if (!docId) {
    console.warn(`DocRelay: autoLink — could not compute docSectionId for ${section.file}#${section.anchor}`);
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

  const counters = { high: 0, medium: 0, low: 0, alreadyLinked: 0 };

  // Build a set of existing mappings for fast skip check.
  // Key: "symbol_id::doc_id::rel_type"
  // Use a lazy iterator (better-sqlite3 iterate()) instead of buffering all
  // rows into memory to avoid the previous 100000-row LIMIT truncation — the
  // set must be complete or stale mappings reappear as duplicates.
  const existingKeys = new Set<string>();
  const existingStmt = db.prepare('SELECT symbol_id, doc_id, rel_type FROM mappings');
  for (const row of existingStmt.iterate() as IterableIterator<{ symbol_id: string; doc_id: string; rel_type: string }>) {
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

  const totalPairs = symbols.length * docSections.length;
  let evaluatedPairs = 0;
  for (const symbol of symbols) {
    if (timedOut()) {
      const dropped = totalPairs - evaluatedPairs;
      console.warn(`DocRelay: autoLink timed out after ${AUTO_LINK_TIMEOUT_MS}ms during pass 1 — returning partial results (${dropped} symbol×section pairs not evaluated).`);
      return {
        totalMatched: counters.high + counters.medium + counters.low,
        highConfidence: counters.high,
        mediumConfidence: counters.medium,
        lowConfidence: counters.low,
        alreadyLinked: counters.alreadyLinked,
      };
    }

    for (const section of docSections) {
      evaluatedPairs++;
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
      const dropped = totalPairs - evaluatedPairs;
      console.warn(`DocRelay: autoLink timed out after ${AUTO_LINK_TIMEOUT_MS}ms during pass 2 — returning partial results (${dropped} symbol×section pairs not evaluated).`);
      break;
    }

    for (const section of docSections) {
      evaluatedPairs++;
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
    alreadyLinked: counters.alreadyLinked,
  };
}

export interface IngestResult {
  newDocSections: number;
  newMappings: number;
}

/**
 * Create a `describes` mapping from a symbol id to the current section
 * doc id, returning true when a new row was actually inserted. Duplicate
 * mappings are skipped silently.
 */
function createRefMapping(db: Database.Database, symbolId: string, docId: string): boolean {
  try {
    createMapping(db, {
      symbol_id: symbolId,
      doc_id: docId,
      rel_type: 'describes',
      review_status: 'auto',
    });
    return true;
  } catch {
    return false; // duplicate or other constraint — skip
  }
}

/**
 * Ingest parsed doc sections into the database: upsert doc_sections rows and
 * create mappings for code references that match known symbols. This is the
 * shared pipeline used by MCP scan, MCP refresh, CLI scan, and file watcher.
 *
 * Extracted from the 3 duplicate implementations in index.ts (docrelay_scan,
 * docrelay_refresh) and cli.ts (scan command) — now a single source of truth.
 */
export function ingestDocSections(
  db: Database.Database,
  sections: ParsedDocSection[],
): IngestResult {
  let newDocs = 0;
  let newMappings = 0;

  for (const section of sections) {
    // Wrap per-section processing in try/catch to prevent a single corrupted
    // section (empty file, invalid doc_type, etc.) from aborting the entire
    // ingest batch. Matches the defensive pattern in scanProject (scanner.ts).
    try {
      const id = docSectionId(section.file, section.anchor);
      if (!id) continue;

      const hash = contentHash(section.content);
      const existing = db.prepare('SELECT id FROM doc_sections WHERE id = ?').get(id) as { id: string } | undefined;
      upsertDocSection(db, { id, file: section.file, anchor: section.anchor, content_hash: hash, doc_type: 'standalone' });
      if (!existing) newDocs++;

      for (const ref of section.codeRefs) {
        const cleanName = ref.symbolName.replace(/\(.*\)$/, '');
        // Disambiguate same-named symbols across modules. A name-only lookup
        // used to pollute every same-named symbol (different modules) into the
        // same mapping. Now: if exactly one symbol has this name, link it as
        // before; if several do, only link when the symbol's source file stem
        // uniquely equals the doc file stem — otherwise skip (no link).
        const sameNameRows = db.prepare(
          'SELECT id, location FROM symbols WHERE name = ? OR name = ?'
        ).all(cleanName, ref.symbolName) as Array<{ id: string; location: string }>;

        if (sameNameRows.length === 1) {
          if (createRefMapping(db, sameNameRows[0].id, id)) newMappings++;
        } else if (sameNameRows.length > 1) {
          // Compare basename stems only, mirroring the file-name convention in
          // scorePair (docs/auth/login.md ↔ src/auth/login.ts).
          const docFileStem = fileStem((section.file.toLowerCase().replace(/\\/g, '/').split('/').pop() || ''));
          let unique = '';
          for (const cand of sameNameRows) {
            const loc = (cand.location || '').toLowerCase().replace(/\\/g, '/');
            const symFileStem = fileStem(loc.split('/').pop() || loc);
            if (symFileStem === docFileStem && symFileStem.length > 0) {
              // Only when exactly one candidate uniquely owns this stem.
              if (unique && unique !== cand.id) { unique = 'AMBIGUOUS'; break; }
              unique = cand.id;
            }
          }
          if (unique && unique !== 'AMBIGUOUS' && createRefMapping(db, unique, id)) newMappings++;
        }
      }
    } catch (err: any) {
      console.warn(`DocRelay: ingestDocSections — skipping malformed section ${section.file}#${section.anchor}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { newDocSections: newDocs, newMappings };
}
