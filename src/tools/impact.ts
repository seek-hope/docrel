// src/tools/impact.ts
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { assertDbOpen } from '../db/connection.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getDocSection } from '../db/docs.js';

export interface ImpactReport {
  changedFiles: string[];
  affectedSymbols: Array<{
    id: string;
    name: string;
    kind: string;
    location: string;
  }>;
  affectedDocs: Array<{
    id: string;
    file: string;
    anchor: string;
    doc_type: string;
    status: string;
    relationship: string;
  }>;
  errors: Array<{ file: string; message: string }>;
}

function escapeLike(str: string): string {
  // Escape % and _ FIRST, then escape backslashes. Reversing the order
  // (backslash before %) causes the inserted escape backslash to be
  // re-processed as an escape character: '\' + '%' → '\\' + '\%' →
  // '\\\\%' which matches two backslashes (not one) in the data.
  return str.replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\\/g, '\\\\');
}

export function docsyncImpact(
  db: Database.Database,
  changedFiles: string[],
  projectRoot?: string,
): ImpactReport {
  // Cap the input array to prevent DoS via MCP tool invocation with
  // excessively large path lists (e.g., 100,000 entries would make
  // 100,000 SQL queries + realpathSync calls).
  if (changedFiles.length > 1000) {
    return {
      changedFiles,
      affectedSymbols: [],
      affectedDocs: [],
      errors: [{ file: '', message: `Too many files: ${changedFiles.length} (max 1000). Check batches of up to 1000 files at a time.` }],
    };
  }
  try {
    assertDbOpen(db);
  } catch (err: any) {
    return {
      changedFiles,
      affectedSymbols: [],
      affectedDocs: [],
      errors: [{ file: '', message: `Database error: ${err.message}` }],
    };
  }
  const affectedSymbols: ImpactReport['affectedSymbols'] = [];
  const affectedDocs: ImpactReport['affectedDocs'] = [];
  const errors: ImpactReport['errors'] = [];
  const seenDocIds = new Set<string>();

  const seenSymbolIds = new Set<string>();

  const MAX_PATH_LENGTH = 4096;

  for (const file of changedFiles) {
    if (!file || file.trim() === '') {
      errors.push({ file: file || '(empty)', message: 'Empty file path' });
      continue;
    }
    if (file.length > MAX_PATH_LENGTH) {
      console.error(`Warning: Skipping path exceeding ${MAX_PATH_LENGTH} chars: ${file.slice(0, 100)}...`);
      errors.push({ file, message: `Path exceeds ${MAX_PATH_LENGTH} characters` });
      continue;
    }
    try {
      const escaped = escapeLike(file);
      // Match locations in "file:line" format via LIKE prefix match.
      // Filter results to ensure the file portion (before the last colon)
      // exactly equals the changed file. LIKE prefix match alone would also
      // match 'src/foo_test.ts' when checking 'src/foo.ts'.
      const candidateSymbols = db.prepare(
        `SELECT id, name, kind, location FROM symbols
         WHERE location LIKE ? || ':%' ESCAPE '\\'`
      ).all(escaped) as Array<{ id: string; name: string; kind: string; location: string }>;

      // F8: Hoist fileReal computation outside the inner loop.
      // `file` does not change per symbol, so computing realpathSync for
      // every matching symbol wastes filesystem I/O on large codebases.
      const root = projectRoot ?? process.cwd();
      let fileReal = file;
      try {
        fileReal = fs.realpathSync(path.resolve(root, file));
      } catch { /* realpath may fail — fall back to literal comparison */ }

      for (const dbSym of candidateSymbols) {
        // Verify the file portion of the location exactly matches.
        // Resolve symlinks for comparison so that symlinked directories
        // (e.g., src/ -> ../shared/src/) don't cause false mismatches.
        const lastColon = dbSym.location.lastIndexOf(':');
        const locFile = lastColon > 0 ? dbSym.location.slice(0, lastColon) : dbSym.location;
        let locReal = locFile;
        try {
          locReal = fs.realpathSync(path.resolve(root, locFile));
        } catch { /* realpath may fail — fall back to literal comparison */ }
        if (locReal !== fileReal) continue;

        if (seenSymbolIds.has(dbSym.id)) continue;
        seenSymbolIds.add(dbSym.id);
        affectedSymbols.push(dbSym);

        const mappings = getMappingsForSymbol(db, dbSym.id);
        for (const mapping of mappings) {
          if (seenDocIds.has(mapping.doc_id)) continue;
          seenDocIds.add(mapping.doc_id);

          const doc = getDocSection(db, mapping.doc_id);
          if (doc) {
            affectedDocs.push({
              id: doc.id,
              file: doc.file,
              anchor: doc.anchor,
              doc_type: doc.doc_type,
              status: doc.status,
              relationship: mapping.rel_type,
            });
          }
        }
      }
    } catch (err: any) {
      const sanitized = (err instanceof Error ? err.message : String(err))
        .replace(/\/(?:home|opt|var|etc|tmp|mnt|srv)\/[^\s:,)]*/g, '<path>')
        .replace(/[A-Z]:\\[^\s:,)]*/g, '<path>')
        .slice(0, 200);
      console.error(`Warning: Skipping ${file} due to error: ${sanitized}`);
      errors.push({ file, message: sanitized });
    }
  }

  return { changedFiles, affectedSymbols, affectedDocs, errors };
}

/**
 * Format an ImpactReport as human-readable markdown.
 */
export function formatImpactMarkdown(report: ImpactReport): string {
  const lines: string[] = [];

  lines.push('## DocSync Impact Analysis');
  lines.push('');

  // Changed files
  lines.push(`### Changed Files (${report.changedFiles.length})`);
  lines.push('');
  if (report.changedFiles.length > 0) {
    for (const f of report.changedFiles) {
      lines.push(`- \`${f}\``);
    }
  } else {
    lines.push('_(none)_');
  }
  lines.push('');

  // Affected symbols
  lines.push(`### Affected Symbols (${report.affectedSymbols.length})`);
  lines.push('');
  if (report.affectedSymbols.length > 0) {
    for (const s of report.affectedSymbols) {
      lines.push(`- \`${s.name}\` (${s.kind}) — ${s.location}`);
    }
  } else {
    lines.push('_(none)_');
  }
  lines.push('');

  // Affected docs
  lines.push(`### Affected Documentation (${report.affectedDocs.length})`);
  lines.push('');
  if (report.affectedDocs.length > 0) {
    for (const d of report.affectedDocs) {
      const anchorLabel = d.anchor ? `#${d.anchor}` : '';
      lines.push(`- \`${d.file}${anchorLabel}\` — **${d.status}** (${d.relationship})`);
    }
  } else {
    lines.push('_(none)_');
  }
  lines.push('');

  // Errors
  if (report.errors.length > 0) {
    lines.push(`### Errors (${report.errors.length})`);
    lines.push('');
    for (const e of report.errors) {
      lines.push(`- \`${e.file}\`: ${e.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
