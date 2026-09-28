// src/discovery/auto-linker.ts — Zero-annotation symbol↔doc-section auto-linking
import type Database from 'better-sqlite3';
import type { SymbolRow } from '../db/symbols.js';
import type { ParsedDocSection } from './doc-parser.js';
import { createMapping } from '../db/mappings.js';
import { upsertDocSection } from '../db/docs.js';
import { docSectionId, contentHash } from '../utils/hash.js';
import { escapeRegex } from '../utils/fs.js';
import { cachedStmt } from '../db/statements.js';

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

/** Fuzzy-substring check on PRE-normalized strings. autoLink evaluates
 *  O(symbols × sections) pairs, so both sides are normalized once up front
 *  (see buildSymbolProfile/buildSectionProfile) instead of per pair —
 *  identical semantics to normalizing inside the call, minus the repeated work. */
function fuzzyNorm(n: string, h: string): boolean {
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
  const lcsThreshold = Math.max(4, Math.floor(minLen * 0.5));
  // Necessary-condition prefilter: every LCS position consumes one character
  // of n that also occurs in h, so LCS ≤ #{i : n[i] ∈ h}. When even that
  // loose upper bound is below the threshold the O(n·m) DP cannot succeed —
  // skip it. This preserves exact semantics while avoiding most DP runs on
  // non-matching pairs (the common case in the symbols × sections loop).
  let lcsUpperBound = 0;
  for (let i = 0; i < n.length; i++) {
    if (h.includes(n[i])) lcsUpperBound++;
  }
  if (lcsUpperBound < lcsThreshold) return false;
  const lcsLen = longestCommonSubstring(n, h);
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
  return noExt.toLowerCase().replace(/[/\\]+/g, '');
}

// ── Precomputed scoring profiles ─────────────────────────────────────────────
// Everything in these structures depends on exactly ONE side of a
// symbol × section pair. autoLink's pair loop is O(N×M), so per-side work is
// computed once per call instead of per pair — previously every pair re-ran
// escapeRegex, compiled fresh RegExp objects, re-normalized both strings, and
// re-stripped every codeRef, which dominated full-scan time on large projects.

interface SymbolProfile {
  row: SymbolRow;
  /** name with a trailing "(...)" call signature stripped. */
  nameClean: string;
  nameCleanLower: string;
  /** normalize(nameClean) — fuzzy needle side. */
  nameNorm: string;
  /** (?:^|\b)nameClean(?:\b|$) case-insensitive — shared by the heading and
   *  body-text rules (no /g flag, so reuse across .test() calls is safe). */
  wordRe: RegExp;
  /** nameClean.length >= 4 && isCodeLikeIdentifier(nameClean) — body-text gate. */
  codeLike: boolean;
  hasLocation: boolean;
  fileStemLower: string;
}

interface SectionRefProfile {
  refType: string;
  symbolName: string;
  /** symbolName with a trailing "(...)" stripped. */
  refClean: string;
  /** normalize(symbolName) — fuzzy haystack side (heading refs). */
  refNorm: string;
}

interface SectionProfile {
  section: ParsedDocSection;
  heading: string;
  headingLower: string;
  /** normalize(heading) — fuzzy haystack side. */
  headingNorm: string;
  content: string;
  hasFile: boolean;
  fileStemLower: string;
  refs: SectionRefProfile[];
}

function buildSymbolProfile(symbol: SymbolRow): SymbolProfile {
  const nameClean = symbol.name.replace(/\(.*\)$/, '');
  const location = (symbol.location || '').toLowerCase().replace(/\\/g, '/');
  return {
    row: symbol,
    nameClean,
    nameCleanLower: nameClean.toLowerCase(),
    nameNorm: normalize(nameClean),
    wordRe: new RegExp('(?:^|\\b)' + escapeRegex(nameClean) + '(?:\\b|$)', 'i'),
    codeLike: nameClean.length >= 4 && isCodeLikeIdentifier(nameClean),
    hasLocation: location.length > 0,
    fileStemLower: location ? fileStem(location.split('/').pop() || location) : '',
  };
}

function buildSectionProfile(section: ParsedDocSection): SectionProfile {
  const heading = section.anchor || '';
  const docFile = section.file.toLowerCase().replace(/\\/g, '/');
  return {
    section,
    heading,
    headingLower: heading.toLowerCase(),
    headingNorm: normalize(heading),
    content: section.content || '',
    hasFile: docFile.length > 0,
    fileStemLower: docFile ? fileStem(docFile.split('/').pop() || docFile) : '',
    refs: (section.codeRefs ?? []).map((ref) => ({
      refType: ref.refType,
      symbolName: ref.symbolName,
      refClean: ref.symbolName.replace(/\(.*\)$/, ''),
      refNorm: normalize(ref.symbolName),
    })),
  };
}

// ── Confidence scoring ───────────────────────────────────────────────────────

interface ScoreResult {
  confidence: number;
  matched: boolean;
}

/**
 * Compute the highest confidence score for a symbol↔doc-section pair.
 * Profile-based twin of the original scorePair: every per-side value
 * (cleaned names, word-boundary regex, normalized strings, file stems,
 * cleaned codeRefs) comes precomputed from the profiles — the rule logic
 * and confidences are unchanged.
 */
function scoreProfile(
  sp: SymbolProfile,
  cp: SectionProfile,
  minConfidence: number,
): ScoreResult {
  // Cumulative confidence from concrete evidence (name/ref matches). The
  // strongest single piece of evidence wins; we then optionally apply a small
  // file-name convention boost on top when *other* evidence already exists.
  let best = 0;

  // 1. Exact word match in heading (confidence 1.0).
  // The word-boundary regex prevents substring matches like symbol 'get'
  // matching heading 'Getting Started' or 'a' matching any heading.
  // Left side uses (?:^|\b) so symbols starting with non-word chars (e.g.
  // $special_fn) still match at the start of the heading.
  if (cp.heading.length > 0) {
    if (sp.wordRe.test(cp.heading)) {
      best = 1.0;
    } else if (sp.nameClean.length >= 3 && cp.headingLower.includes(sp.nameCleanLower)) {
      // 1b. Substring match in heading (confidence 0.7) — weaker signal,
      // catches partial-name matches like 'getUser' in 'getUserProfile'.
      // (nameClean is non-empty whenever length >= 3, so the empty-needle
      // guard of the old containsIgnoreCase helper is preserved.)
      best = Math.max(best, 0.7);
    }
  }

  // Code reference matches, weighted by ref type:
  //   backtick  0.9 — ``name`` / `name()
  //   codeblock 0.7 — inside a fenced code sample
  //   heading   0.6 — symbol captured from a heading token
  //   bodytext  0.4 — bare identifier in prose (weak, e.g. "the login function")
  const symName = sp.row.name;
  for (const ref of cp.refs) {
    const refEq = ref.refClean === sp.nameClean ||
      ref.refClean === symName ||
      ref.symbolName === symName ||
      ref.symbolName === sp.nameClean;

    switch (ref.refType) {
      case 'backtick':
        if (refEq) best = Math.max(best, 0.9);
        break;
      case 'codeblock':
        if (refEq) best = Math.max(best, 0.7);
        break;
      case 'heading':
        // Also allow fuzzy match against a heading-captured ref.
        if (refEq || fuzzyNorm(sp.nameNorm, ref.refNorm)) best = Math.max(best, 0.6);
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
  if (cp.heading.length > 0 && fuzzyNorm(sp.nameNorm, cp.headingNorm)) {
    best = Math.max(best, 0.6);
  }

  // 6. Body-text word match (confidence 0.4) — directly scan the section
  // content for identifiers that look like code symbols (CamelCase,
  // PascalCase, snake_case). Minimum 4 characters; all-lowercase names are
  // only reachable via 'bodytext' codeRefs produced by doc-parser so that
  // plain English prose (which is all-lowercase) stays hard to match.
  if (sp.codeLike && (sp.wordRe.test(cp.content) || sp.wordRe.test(cp.heading))) {
    best = Math.max(best, 0.4);
  }

  // 5. File-name convention — now a *boost* only, never a standalone match.
  // When the doc file stem equals the symbol's source file stem (e.g.
  // docs/auth.md ↔ src/auth.ts) we raise the confidence of an already-matched
  // pair, but identical stems alone never create a link — that caused massive
  // false positives where every symbol in a file got linked to every section
  // of the same-named doc. +0.1, capped at 1.0.
  if (best > 0 && sp.hasLocation && cp.hasFile &&
      sp.fileStemLower === cp.fileStemLower && sp.fileStemLower.length > 0) {
    best = Math.min(1.0, best + 0.1);
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
 * cheap to compute on precomputed profiles. Returns confidence (1.0, 0.9)
 * or 0 if no match.
 */
function fastScoreProfile(sp: SymbolProfile, cp: SectionProfile): number {
  // 1. Exact word match in heading (confidence 1.0)
  if (cp.heading.length > 0 && sp.wordRe.test(cp.heading)) {
    return 1.0;
  }

  // 2. Backtick match (confidence 0.9)
  const symName = sp.row.name;
  for (const ref of cp.refs) {
    if (ref.refType === 'backtick' &&
        (ref.refClean === sp.nameClean ||
         ref.refClean === symName ||
         ref.symbolName === symName ||
         ref.symbolName === sp.nameClean)) {
      return 0.9;
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
    if ((err)?.code?.startsWith('SQLITE_CONSTRAINT')) {
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

  // Precompute one scoring profile per side — everything the pair loop needs
  // that depends on a single side (cleaned names, word-boundary regexes,
  // normalized strings, file stems, cleaned codeRefs). Building these inside
  // the O(symbols × sections) loop dominated full-scan time on large projects.
  const symbolProfiles = symbols.map(buildSymbolProfile);
  const sectionProfiles = docSections.map(buildSectionProfile);

  // ── Pass 1: Exact matches only (heading word boundary + backtick) ──────
  // This pass is O(symbols × sections) but each comparison is cheap (no
  // fuzzy substring, no codeRef iteration beyond backtick). For a 2000×500
  // project (1M pairs), pass 1 runs in under a second.

  const totalPairs = symbols.length * docSections.length;
  let evaluatedPairs = 0;
  for (const sp of symbolProfiles) {
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

    for (const cp of sectionProfiles) {
      evaluatedPairs++;
      const conf = fastScoreProfile(sp, cp);
      if (conf === 0) continue;

      const docId = tryDocSectionId(cp.section);
      if (!docId) continue;

      if (tryCreateMapping(db, sp.row, docId, conf, existingKeys, counters)) {
        linkedSymbolIds.add(sp.row.id);
      }
    }
  }

  // ── Pass 2: Full scoring for unlinked symbols ───────────────────────────
  // Only symbols without any pass-1 link go through the slower fuzzy matching.
  // This is typically a much smaller set, so the expensive isFuzzySubstring
  // calls are bounded to a fraction of the total symbol×section space.

  for (const sp of symbolProfiles) {
    if (linkedSymbolIds.has(sp.row.id)) continue;

    if (timedOut()) {
      const dropped = totalPairs - evaluatedPairs;
      console.warn(`DocRelay: autoLink timed out after ${AUTO_LINK_TIMEOUT_MS}ms during pass 2 — returning partial results (${dropped} symbol×section pairs not evaluated).`);
      break;
    }

    for (const cp of sectionProfiles) {
      evaluatedPairs++;
      const score = scoreProfile(sp, cp, minConfidence);
      if (!score.matched) continue;

      const docId = tryDocSectionId(cp.section);
      if (!docId) continue;

      tryCreateMapping(db, sp.row, docId, score.confidence, existingKeys, counters);
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
    // Existence pre-check: createMapping is an UPSERT whose ON CONFLICT clause
    // would rewrite (and count as "new") an existing row — re-ingesting an
    // unchanged doc would churn the WAL and inflate the newMappings metric.
    const existing = cachedStmt(db,
      `SELECT 1 AS x FROM mappings WHERE symbol_id = ? AND doc_id = ? AND rel_type = 'describes'`,
    ).get(symbolId, docId);
    if (existing) return false;
    createMapping(db, {
      symbol_id: symbolId,
      doc_id: docId,
      rel_type: 'describes',
      review_status: 'auto',
    });
    return true;
  } catch {
    return false; // constraint or other failure — skip
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

  // Wrap the ingest batch in ONE transaction — per-section upserts otherwise
  // auto-commit individually (a WAL flush each), which dominates ingest time
  // on doc-heavy projects. Per-section errors are caught inside the loop, so
  // one corrupted section does not roll back the batch.
  // Prepare statements once — better-sqlite3 compiles SQL on every prepare()
  // call, so preparing inside the per-section loop measurably dominates
  // ingest time on doc-heavy projects.
  const existingSectionStmt = db.prepare('SELECT id FROM doc_sections WHERE id = ?');
  const sameNameStmt = db.prepare('SELECT id, location FROM symbols WHERE name = ? OR name = ?');
  db.transaction(() => {
  for (const section of sections) {
    // Wrap per-section processing in try/catch to prevent a single corrupted
    // section (empty file, invalid doc_type, etc.) from aborting the entire
    // ingest batch. Matches the defensive pattern in scanProject (scanner.ts).
    try {
      const id = docSectionId(section.file, section.anchor);
      if (!id) continue;

      const hash = contentHash(section.content);
      const existing = existingSectionStmt.get(id) as { id: string } | undefined;
      upsertDocSection(db, { id, file: section.file, anchor: section.anchor, content_hash: hash, doc_type: 'standalone' });
      if (!existing) newDocs++;

      for (const ref of section.codeRefs) {
        const cleanName = ref.symbolName.replace(/\(.*\)$/, '');
        // Disambiguate same-named symbols across modules. A name-only lookup
        // used to pollute every same-named symbol (different modules) into the
        // same mapping. Now: if exactly one symbol has this name, link it as
        // before; if several do, only link when the symbol's source file stem
        // uniquely equals the doc file stem — otherwise skip (no link).
        const sameNameRows = sameNameStmt.all(cleanName, ref.symbolName) as Array<{ id: string; location: string }>;

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
  })();

  return { newDocSections: newDocs, newMappings };
}
