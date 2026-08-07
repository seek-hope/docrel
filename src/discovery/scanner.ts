// src/discovery/scanner.ts
import type Database from 'better-sqlite3';
import type { SymbolExtractor } from '../extractors/interface.js';
import type { DocRelayConfig } from '../utils/config.js';
import { upsertSymbol, markSignatureChanged, recordSignatureChange, recordSymbolCreated } from '../db/symbols.js';
import { upsertDocSection, markInlineStaleForSymbol } from '../db/docs.js';
import { ensureMapping } from '../db/mappings.js';
import { symbolId, contentHash, docSectionId } from '../utils/hash.js';
import { assertDbOpen } from '../db/connection.js';
import { isIgnored } from '../utils/ignore.js';

/**
 * Parse a stored `last_scan_at` value into a UTC epoch (ms), or undefined when
 * it is missing/unparseable.
 *
 * Two formats are accepted for backward/forward compatibility:
 *   - legacy SQLite UTC format:  `YYYY-MM-DD HH:MM:SS` (datetime('now'))
 *   - ISO-8601:                  `YYYY-MM-DDTHH:MM:SS.sssZ`
 * Both are normalized to a timezone-independent instant before being compared
 * against fs mtime (which is already an absolute epoch).
 */
export function parseLastScanAt(value: string): number | undefined {
  if (!value || !value.trim()) return undefined;
  const trimmed = value.trim();
  let iso: string;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
    // Legacy SQLite datetime('now') emits UTC without a timezone suffix.
    iso = trimmed.replace(' ', 'T') + 'Z';
  } else {
    iso = trimmed;
  }
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? undefined : ms;
}

/** Escape :: in FQN components to prevent symbol ID collisions. */
function escFqn(s: string): string {
  return s.replace(/::/g, '%3A%3A');
}

import { createProgressReporter } from '../utils/progress.js';

/** Codegraph symbol kind → canonical DocRelay kind mapping (module-level). */
const KIND_MAP: Record<string, ReturnType<typeof mapKind>> = {
  function: 'function', method: 'function', func: 'function',
  class: 'class', struct: 'class',
  module: 'module', namespace: 'module',
  api_endpoint: 'api_endpoint', endpoint: 'api_endpoint', route: 'api_endpoint',
  type: 'type', interface: 'interface',
  variable: 'variable', const: 'variable', let: 'variable',
};

export interface ScanReport {
  totalSymbols: number;
  newSymbols: number;
  updatedSymbols: number;
  failedDirs: string[];
  /** All symbol IDs that were found during this scan. Used by `docrelay gc` to
   *  identify symbols that existed in the database but were not re-discovered. */
  scannedIds: string[];
}

export async function scanProject(
  extractor: SymbolExtractor,
  db: Database.Database,
  config: DocRelayConfig,
  projectRoot: string,
  fullScan = true,
): Promise<ScanReport> {
  assertDbOpen(db);
  const failedDirs: string[] = [];
  if (config.code_dirs.length === 0) {
    console.warn('Warning: No code directories configured. Set code_dirs in .docrelay/config.yaml');
    return { totalSymbols: 0, newSymbols: 0, updatedSymbols: 0, failedDirs, scannedIds: [] };
  }

  // Read last scan timestamp for incremental scanning. When fullScan is false,
  // only re-scan files with mtime > last scan time.
  const since = fullScan ? undefined : (() => {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_scan_at'").get() as { value: string } | undefined;
    if (row?.value) return parseLastScanAt(row.value);
    return undefined;
  })();

  // Whether the configured strategy wants inline doc_sections collected at all.
  // strategy 'ignore' disables collection; every other value (auto_update,
  // mark_stale) enables the inline collection path.
  const inlineEnabled = config.strategies?.inline !== 'ignore';

  let newSymbols = 0;
  let updatedSymbols = 0;
  const scannedIds = new Set<string>();

  // Track duplicate occurrences of (file, name, kind) so that same-named
  // symbols in the same file get deterministic disambiguating suffixes
  // (::#2, ::#3, ...) instead of being keyed by their line number. This makes
  // symbol IDs stable under line-number drift (e.g. a comment inserted above).
  /** key `file\u0000kind` -> Map<`name\u0000kind`, count> */
  const fileDupCounts = new Map<string, Map<string, number>>();

  /** base symbolId -> set of signature hashes seen this scan. Overlapping
   *  extractor results (e.g. codegraph explore returning a dependency file's
   *  source section for several code_dirs) report the SAME definition
   *  multiple times — identical name/kind/signature. Those are skipped, not
   *  suffixed, so they never multiply into ::#2/::#3 pseudo-duplicates. */
  const seenSignaturesById = new Map<string, Set<string>>();

  for (const codeDir of config.code_dirs) {
    try {
      // Use the pluggable extractor to discover all symbols in each code directory
      const symbols = await extractor.extract(codeDir, projectRoot, since);

      const MAX_SYMBOLS_PER_DIR = 10000;
      let dirSymbolCount = 0;
      let symIdx = 0;
      const reportProgress = createProgressReporter(symbols.length, `Scanning ${codeDir}`);
      for (const sym of symbols) {
        reportProgress(++symIdx);
        // Skip symbols whose source file matches a .docrelayignore pattern
        if (isIgnored(sym.file, projectRoot)) continue;

        // Wrap per-symbol processing in its own try/catch to prevent a single
        // malformed symbol (e.g., undefined fields from a changed codegraph
        // response) from aborting the entire directory's scan.
        try {
          if (++dirSymbolCount > MAX_SYMBOLS_PER_DIR) {
            console.warn(`DocRelay: scan of '${codeDir}' exceeded ${MAX_SYMBOLS_PER_DIR} symbols — stopping to prevent memory pressure`);
            break;
          }
          const lang = sym.language;
          // Stable FQN: `${file}::${name}` (with :: suppressed via escFqn). Do NOT
          // include the line number — line-based FQN made every symbol ID drift
          // when a single line was inserted above, silently dropping mappings.
          // Same-named same-kind symbols in one file are disambiguated by an
          // occurrence suffix (::#2, ::#3, ...) computed below, which is
          // deterministic for the builtin extractor (symbols are emitted in
          // line order) and does not depend on the absolute line number.
          const baseFile = escFqn(sym.file);
          const baseName = escFqn(sym.name);
          const dupKey = `${sym.file}\u0000${sym.kind}`;
          let nameCounts = fileDupCounts.get(dupKey);
          if (!nameCounts) {
            nameCounts = new Map<string, number>();
            fileDupCounts.set(dupKey, nameCounts);
          }
          const nameKey = `${baseName}\u0000${sym.kind}`;

          // Exact-duplicate guard: same file::name AND same signature as an
          // earlier occurrence in this scan = the same definition reported
          // again by overlapping extractor output — skip it. Also skip the
          // uninformative variant (no signature) when a signed variant of the
          // same file::name exists (kind guesses without signatures would
          // otherwise double-list the symbol under a second kind).
          const baseFqn = `${baseFile}::${baseName}`;
          const baseId = symbolId(lang, baseFqn, sym.kind);
          const sigHere = contentHash(sym.signature ?? '');
          let sigSet = seenSignaturesById.get(baseFqn);
          if (sigSet?.has(sigHere)) continue;
          if (sigSet && sigSet.size > 0 && !sym.signature) continue;
          if (!sigSet) {
            sigSet = new Set<string>();
            seenSignaturesById.set(baseFqn, sigSet);
          }
          sigSet.add(sigHere);

          const occurrence = (nameCounts.get(nameKey) ?? 0) + 1;
          nameCounts.set(nameKey, occurrence);
          const suffix = occurrence > 1 ? `::#${occurrence}` : '';
          const fqn = `${baseFile}::${baseName}${suffix}`;
          const id = symbolId(lang, fqn, sym.kind);
          // Skip symbols that produce an empty ID (invalid/missing data from codegraph)
          if (!id) continue;
          const rawSig = sym.raw_signature ?? sym.signature ?? '';
          const sig = contentHash(sym.signature ?? '');

          scannedIds.add(id);

          const existing = db.prepare('SELECT id, signature, raw_signature FROM symbols WHERE id = ?').get(id) as
            | { id: string; signature: string; raw_signature: string }
            | undefined;

          if (!existing) {
            upsertSymbol(db, {
              id,
              name: sym.name,
              kind: mapKind(sym.kind),
              project: codeDir,
              location: `${sym.file}:${sym.line}`,
              signature: sig,
              raw_signature: rawSig,
            });
            // Record a 'created' changelog entry for the newly discovered symbol.
            recordSymbolCreated(db, id, sig);
            newSymbols++;
          } else if (existing.signature !== sig) {
            upsertSymbol(db, {
              id,
              name: sym.name,
              kind: mapKind(sym.kind),
              project: codeDir,
              location: `${sym.file}:${sym.line}`,
              signature: sig,
              raw_signature: rawSig,
            });
            // Record changelog entry so docrelayDiff and the changelog table
            // surface what changed between scans.
            const logged = markSignatureChanged(db, id, existing.signature, sig, rawSig, existing.raw_signature || undefined);
            if (logged) {
              updatedSymbols++;
            } else {
              // If markSignatureChanged returned false (0 rows updated), another
              // connection may have deleted the symbol between our SELECT and the
              // UPDATE inside markSignatureChanged. The symbol WAS upserted above
              // with the new signature — close the TOCTOU gap by re-checking
              // existence and writing the changelog (with affected_docs) inside
              // a transaction.
              const inserted = db.transaction(() => {
                const stillExists = db.prepare('SELECT 1 FROM symbols WHERE id = ?').get(id);
                if (!stillExists) {
                  console.warn(`DocRelay: markSignatureChanged failed for ${id} — symbol deleted concurrently, changelog entry not created`);
                  return false;
                }
                recordSignatureChange(db, id, existing.signature, sig, { oldRaw: existing.raw_signature || undefined, newRaw: rawSig });
                return true;
              })();
              if (inserted) {
                updatedSymbols++;
                console.warn(`DocRelay: markSignatureChanged returned false for ${id} (race condition?) — changelog entry inserted directly`);
              }
            }
          }

          // ── Inline doc_section collection ────────────────────────────────
          // When the extraction produced a docstring and the configured strategy
          // does not ignore inline docs, capture it as an `inline` doc_section
          // and link it to the symbol. When a symbol no longer has a docstring
          // (removed), any previously-collected inline doc_section is marked
          // stale so the sync layer picks it up for cleanup.
          if (inlineEnabled) {
            const doc = sym.docstring;
            if (doc) {
              const anchor = 'inline:' + sym.name;
              const docId = docSectionId(sym.file, anchor);
              if (docId) {
                upsertDocSection(db, {
                  id: docId,
                  file: sym.file,
                  anchor,
                  content_hash: contentHash(doc),
                  doc_type: 'inline',
                });
                ensureMapping(db, { symbol_id: id, doc_id: docId, rel_type: 'describes', review_status: 'auto' });
              }
            } else {
              // No docstring for a still-present symbol — stale its inline docs.
              markInlineStaleForSymbol(db, id);
            }
          }
        } catch (e: any) {
          console.warn(`DocRelay: skipping malformed symbol in '${codeDir}': ${e?.message ?? e}`);
          // continue to next symbol — individual failures do not abort the directory
        }
      }
    } catch (err: any) {
      const safeName = codeDir.replace(/[\x00-\x1f\x7f]/g, '');
      failedDirs.push(safeName);
      // Sanitize error message — extract only the meaningful part (first 200 chars,
      // with absolute paths stripped) to prevent information disclosure in MCP/CLI
      // responses that include warnings from this scan.
      const rawMsg = err instanceof Error ? err.message : String(err);
      const sanitized = rawMsg.replace(/\/[^\s:,)]{20,}/g, '...').slice(0, 200);
      console.warn(`DocRelay: Failed to scan directory '${safeName}': ${sanitized}`);
    }
  }

  // Use scannedIds count instead of COUNT(*) to avoid counting symbols
  // from other projects or prior scans that this scan did not touch.
  // Since the scan loop already upserted new symbols into the database,
  // the subsequent SELECT returns ALL scanned symbols (both old and new).
  // So existingSymbols.size already includes newSymbols — do NOT add it again.
  const existingSymbols = new Set<string>();
  if (scannedIds.size > 0) {
    // Batch IN query to avoid exceeding SQLite's SQLITE_MAX_VARIABLE_NUMBER (default 999)
    const ids = [...scannedIds];
    const BATCH_SIZE = 500;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const existingRows = db.prepare(
        'SELECT id FROM symbols WHERE id IN (' + batch.map(() => '?').join(',') + ')'
      ).all(...batch) as Array<{ id: string }>;
      for (const row of existingRows) existingSymbols.add(row.id);
    }
  }

  // Record the scan timestamp so status reports show when a scan last ran,
  // not when the last symbol change occurred. Unchanged symbols retain their
  // old updated_at, so MAX(updated_at) can be misleading after no-change scans.
  // Store an unambiguous ISO-8601 UTC timestamp so `since` parsing has no
  // timezone ambiguity. (Legacy `datetime('now')` values remain readable via
  // parseLastScanAt, which normalizes both formats to a UTC epoch.)
  const scanEndIso = new Date().toISOString();
  db.prepare(
    "INSERT INTO metadata (key, value, updated_at) VALUES ('last_scan_at', ?, datetime('now')) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(scanEndIso);

  return { totalSymbols: existingSymbols.size, newSymbols, updatedSymbols, failedDirs, scannedIds: [...scannedIds] };
}

function mapKind(kind: string): 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable' | 'unknown' {
  const mapped = KIND_MAP[kind.toLowerCase()];
  if (!mapped) {
    console.warn(`DocRelay: Unknown symbol kind '${kind}' — storing as 'unknown'`);
    return 'unknown';
  }
  return mapped;
}
