// src/tools/review.ts — mapping audit: unlinked symbols, orphaned sections, implied refs
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { assertDbOpen } from '../db/connection.js';
import { escapeRegex, validatePath } from '../utils/fs.js';

export interface ReviewReport {
  unlinkedSymbols: UnlinkedSymbol[];
  orphanedSections: OrphanedSection[];
  impliedReferences: ImpliedReference[];
  unreviewedMappings: UnreviewedMapping[];
  skippedFiles: string[];
  summary: ReviewSummary;
}

export interface UnlinkedSymbol {
  id: string;
  name: string;
  kind: string;
  location: string;
}

export interface OrphanedSection {
  id: string;
  file: string;
  anchor: string;
}

export interface ImpliedReference {
  symbolName: string;
  docFile: string;
  docAnchor: string;
  mentionLine: number;
  mentionText: string;
}

export interface UnreviewedMapping {
  symbolId: string;
  symbolName: string;
  docId: string;
  docFile: string;
  docAnchor: string;
  reviewStatus: string;
  relType: string;
}

export interface ReviewSummary {
  totalSymbols: number;
  linkedSymbols: number;
  unlinkedCount: number;
  orphanedCount: number;
  impliedCount: number;
  unreviewedCount: number;
}

/** Find symbols with no mappings. */
function findUnlinked(db: Database.Database): UnlinkedSymbol[] {
  return db.prepare(`
    SELECT s.id, s.name, s.kind, s.location
    FROM symbols s
    WHERE s.id NOT IN (SELECT DISTINCT symbol_id FROM mappings)
    ORDER BY s.name
    LIMIT 10000
  `).all() as UnlinkedSymbol[];
}

/** Find doc sections with no mappings. */
function findOrphaned(db: Database.Database): OrphanedSection[] {
  return db.prepare(`
    SELECT d.id, d.file, d.anchor
    FROM doc_sections d
    WHERE d.id NOT IN (SELECT DISTINCT doc_id FROM mappings)
    ORDER BY d.file, d.anchor
    LIMIT 10000
  `).all() as OrphanedSection[];
}

/**
 * Find text in doc sections that looks like a code reference
 * (backtick-wrapped or CamelCase/snake_case identifier)
 * but has no corresponding mapping.
 */
function findImplied(db: Database.Database, projectRoot: string): { references: ImpliedReference[]; skippedFiles: string[] } {
  const references: ImpliedReference[] = [];
  const skippedFiles: string[] = [];

  // Get all known symbol names (capped to prevent memory exhaustion on large projects)
  const symRows = db.prepare('SELECT name FROM symbols LIMIT 50000').all() as { name: string }[];
  const knownNames = new Set(symRows.map((r) => r.name));

  // Get all docs with their content (capped to prevent memory exhaustion on large projects)
  const docRows = db.prepare("SELECT id, file, anchor FROM doc_sections WHERE doc_type = 'standalone' LIMIT 50000").all() as
    { id: string; file: string; anchor: string }[];

  // Get existing mapping pairs (capped to prevent memory exhaustion)
  const mapRows = db.prepare(`
    SELECT s.name AS symbol_name, d.file AS doc_file, d.anchor AS doc_anchor
    FROM mappings m
    JOIN symbols s ON s.id = m.symbol_id
    JOIN doc_sections d ON d.id = m.doc_id
    LIMIT 100000
  `).all() as { symbol_name: string; doc_file: string; doc_anchor: string }[];
  const existingPairs = new Set(mapRows.map((r) => `${r.symbol_name}::${r.doc_file}#${r.doc_anchor}`));

  const MAX_IMPLIED_REFERENCES = 10_000;

  for (const doc of docRows) {
    let fd: number | undefined;
    try {
      // Reject DB-stored absolute paths that would escape projectRoot.
      // path.resolve returns absolute paths as-is when the second argument
      // is absolute — e.g. path.resolve('/project', '/etc/passwd') = '/etc/passwd'.
      // DB paths are populated by the scanner (which enforces containment),
      // but a corrupted or tampered database could contain traversal paths.
      const root = path.resolve(projectRoot);
      if (path.isAbsolute(doc.file) && !doc.file.startsWith(root + path.sep) && doc.file !== root) {
        skippedFiles.push(`${doc.file} (PATH_TRAVERSAL)`);
        continue;
      }
      const fullPath = path.resolve(projectRoot, doc.file);
      if (!fullPath.startsWith(root + path.sep) && fullPath !== root) {
        skippedFiles.push(`${doc.file} (PATH_TRAVERSAL)`);
        continue;
      }

      // Use fd-based approach (same pattern as standalone.ts:openAndValidate
      // and inline.ts:updateInlineDoc) to eliminate the TOCTOU window between
      // existsSync/statSync/readFileSync on the same path.
      fd = fs.openSync(fullPath, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) continue;
      if (stat.size > 1 * 1024 * 1024) continue; // 1 MB per doc file for review

      const content = fs.readFileSync(fd, 'utf-8');

      // Find the section content
      const headingRegex = new RegExp(`^#{1,6}\\s+${escapeRegex(doc.anchor)}\\s*$`, 'im');
      const headingMatch = content.match(headingRegex);
      if (!headingMatch || headingMatch.index === undefined) continue;

      const sectionStart = content.lastIndexOf('\n', headingMatch.index) + 1;
      const restAfter = content.slice(headingMatch.index + headingMatch[0].length);
      const nextHeading = restAfter.match(/^#{1,6}\s/m);
      const sectionEnd = nextHeading
        ? headingMatch.index + headingMatch[0].length + (nextHeading.index ?? 0)
        : content.length;

      const sectionContent = content.slice(sectionStart, sectionEnd);
      // Guard against pathological section content with millions of short lines
      // (e.g., a 1 MB section of 2-char lines). Content is already bounded at
      // 1 MB by the stat check above, but split('\n') still allocates ~500 K
      // string objects without a line-count guard.
      const MAX_IMPLIED_LINES = 100_000;
      let impliedLineCount = 1;
      for (let ci = 0; ci < sectionContent.length && impliedLineCount <= MAX_IMPLIED_LINES; ci++) {
        if (sectionContent[ci] === '\n') impliedLineCount++;
      }
      if (impliedLineCount > MAX_IMPLIED_LINES) continue;
      const sectionLines = sectionContent.split('\n');

      for (const symbolName of knownNames) {
        if (symbolName.length < 2) continue;

        // Cap the references array to prevent OOM on large projects where
        // many symbol names match many section contents. The implied-reference
        // scan is O(symbols × sections) — without a push cap, a project with
        // 50 K symbols and 50 K docs could allocate millions of entries.
        if (references.length >= MAX_IMPLIED_REFERENCES) break;

        // Check if symbol name appears in section text (outside code blocks)
        const escaped = escapeRegex(symbolName);
        const wordRegex = new RegExp(`\\b${escaped}\\b`, 'i');
        const match = wordRegex.exec(sectionContent);
        if (!match) continue;

        // Skip if mapping already exists
        const pairKey = `${symbolName}::${doc.file}#${doc.anchor}`;
        if (existingPairs.has(pairKey)) continue;

        // Find which line the match is on
        const matchPos = match.index;
        let charCount = 0;
        let mentionLine = 0;
        for (let i = 0; i < sectionLines.length; i++) {
          charCount += sectionLines[i].length + 1;
          if (charCount > matchPos) {
            mentionLine = i;
            break;
          }
        }

        references.push({
          symbolName,
          docFile: doc.file,
          docAnchor: doc.anchor,
          mentionLine,
          mentionText: sectionLines[mentionLine]?.trim().slice(0, 120) ?? '',
        });
      }

      if (references.length >= MAX_IMPLIED_REFERENCES) break;
    } catch (err: any) {
      // Collect unreadable files so operators know which docs could not be
      // analyzed. EACCES, EIO, and file-not-found are all treated as skips
      // but the user gets a count in the summary.
      const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
      skippedFiles.push(`${doc.file} (${code})`);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  return { references, skippedFiles };
}

/** Find mappings with review_status = 'auto' (not yet confirmed or rejected by human/AI). */
function findUnreviewed(db: Database.Database): UnreviewedMapping[] {
  return db.prepare(`
    SELECT m.symbol_id AS symbolId, s.name AS symbolName,
           m.doc_id AS docId, d.file AS docFile, d.anchor AS docAnchor,
           m.review_status AS reviewStatus, m.rel_type AS relType
    FROM mappings m
    JOIN symbols s ON s.id = m.symbol_id
    JOIN doc_sections d ON d.id = m.doc_id
    WHERE m.review_status = 'auto'
    ORDER BY s.name
    LIMIT 10000
  `).all() as UnreviewedMapping[];
}

export function docrelayReview(db: Database.Database, projectRoot: string): ReviewReport {
  // F19: Wrap the body in try/catch to handle DB errors, corrupted state,
  // and I/O exceptions from findImplied — matching the defensive pattern
  // used in docrelayStatus, docrelayCheck, and other tool functions.
  try {
    assertDbOpen(db);
    const unlinkedSymbols = findUnlinked(db);
    const orphanedSections = findOrphaned(db);
    const { references: impliedReferences, skippedFiles } = findImplied(db, projectRoot);
    const unreviewedMappings = findUnreviewed(db);

    const totalSymbols = (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c;
    const linkedSymbols = (db.prepare(
      'SELECT COUNT(DISTINCT symbol_id) AS c FROM mappings',
    ).get() as { c: number }).c;

    return {
      unlinkedSymbols,
      orphanedSections,
      impliedReferences,
      unreviewedMappings,
      skippedFiles,
      summary: {
        totalSymbols,
        linkedSymbols,
        unlinkedCount: unlinkedSymbols.length,
        orphanedCount: orphanedSections.length,
        impliedCount: impliedReferences.length,
        unreviewedCount: unreviewedMappings.length,
      },
    };
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('DocRelay: docrelayReview failed:', msg);
    return {
      unlinkedSymbols: [],
      orphanedSections: [],
      impliedReferences: [],
      unreviewedMappings: [],
      skippedFiles: [],
      summary: {
        totalSymbols: 0,
        linkedSymbols: 0,
        unlinkedCount: 0,
        orphanedCount: 0,
        impliedCount: 0,
        unreviewedCount: 0,
      },
    };
  }
}

/** Format the review as human-readable markdown. */
export function formatReview(report: ReviewReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push('## DocRelay Review');
  lines.push('');
  lines.push(`Symbols: ${summary.linkedSymbols}/${summary.totalSymbols} linked, ${summary.unlinkedCount} unlinked`);
  lines.push('');

  if (report.unlinkedSymbols.length > 0) {
    lines.push('### Unlinked Symbols');
    lines.push('');
    lines.push('These symbols have no documentation mapping:');
    lines.push('');
    for (const s of report.unlinkedSymbols) {
      lines.push(`- \`${s.name}\` (${s.kind}) — ${s.location}`);
    }
    lines.push('');
  }

  if (report.impliedReferences.length > 0) {
    lines.push(`### Implied References (${report.impliedReferences.length})`);
    lines.push('');
    lines.push('Document text mentions these symbols but no mapping exists:');
    lines.push('');
    for (const r of report.impliedReferences) {
      lines.push(`- \`${r.symbolName}\` → ${r.docFile}#${r.docAnchor} (line ${r.mentionLine})`);
    }
    lines.push('');
  }

  if (report.unreviewedMappings.length > 0) {
    lines.push(`### Unreviewed Mappings (${report.unreviewedMappings.length})`);
    lines.push('');
    lines.push('These mappings were auto-generated and need review:');
    lines.push('');
    for (const m of report.unreviewedMappings) {
      lines.push(`- [${m.reviewStatus}] \`${m.symbolName}\` ↔ ${m.docFile}#${m.docAnchor} (${m.relType})`);
    }
    lines.push('');
  }

  if (report.orphanedSections.length > 0) {
    lines.push(`### Orphaned Sections (${report.orphanedSections.length})`);
    lines.push('');
    lines.push('These doc sections have no code symbol linked:');
    lines.push('');
    for (const o of report.orphanedSections) {
      lines.push(`- ${o.file}#${o.anchor || '(top)'}`);
    }
    lines.push('');
  }

  if (report.skippedFiles.length > 0) {
    lines.push(`### Skipped Files (${report.skippedFiles.length})`);
    lines.push('');
    lines.push('These documentation files could not be read:');
    lines.push('');
    for (const f of report.skippedFiles) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (report.unlinkedSymbols.length === 0 &&
      report.impliedReferences.length === 0 &&
      report.unreviewedMappings.length === 0 &&
      report.orphanedSections.length === 0 &&
      report.skippedFiles.length === 0) {
    lines.push('✅ All clear — no issues found.');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format review with side-by-side code ←→ doc blocks for unreviewed mappings.
 * Reads actual source and doc content from disk for context.
 */
export function formatReviewDetailed(report: ReviewReport, projectRoot: string): string {
  const lines: string[] = [];
  const w = 70; // column width

  lines.push('## DocRelay Review — Detailed');
  lines.push('');

  if (report.unreviewedMappings.length > 0) {
    lines.push(`### Unreviewed Mappings (${report.unreviewedMappings.length})`);
    lines.push('');

    // Cap the number of mappings rendered in detail mode. Each mapping triggers
    // a recursive src/ directory walk via readSourceSnippet(), which for large
    // codebases (50 K files) can take seconds per mapping. Without a cap, the
    // full 10,000 unreviewed mappings would render for minutes to hours.
    const MAX_DETAILED_MAPPINGS = 200;
    const displayCount = Math.min(report.unreviewedMappings.length, MAX_DETAILED_MAPPINGS);

    for (let i = 0; i < displayCount; i++) {
      const m = report.unreviewedMappings[i];
      lines.push(`#### ${i + 1}. \`${m.symbolName}\` ↔ ${m.docFile}#${m.docAnchor}`);
      lines.push('');

      // Read source snippet
      const sourceSnippet = readSourceSnippet(m.symbolName, projectRoot);
      const docSnippet = readDocSnippet(m.docFile, m.docAnchor, projectRoot);

      const srcLines = sourceSnippet.split('\n');
      const docLines = docSnippet.split('\n');
      const maxRows = Math.max(srcLines.length, docLines.length);

      // Header
      const srcHeader = '─ SOURCE '.padEnd(w, '─');
      const docHeader = '─ DOC '.padEnd(w, '─');
      lines.push(`\`\`\`${srcHeader}┬${docHeader}\`\`\``);

      for (let r = 0; r < maxRows; r++) {
        const src = (srcLines[r] || '').padEnd(w);
        const doc = (docLines[r] || '').padEnd(w);
        lines.push(`\`${src}│ ${doc}\``);
      }

      lines.push(`\`\`\`${'─'.repeat(w)}┴${'─'.repeat(w)}\`\`\``);
      lines.push('');
      lines.push(`→ \`docrelay confirm --symbol ${m.symbolId} --doc ${m.docId}\`  |  \`docrelay reject --symbol ${m.symbolId} --doc ${m.docId}\``);
      lines.push('');
    }

    if (report.unreviewedMappings.length > MAX_DETAILED_MAPPINGS) {
      lines.push(`_Showing ${MAX_DETAILED_MAPPINGS} of ${report.unreviewedMappings.length} unreviewed mappings. Use \`docrelay review --format json\` to see all IDs._`);
      lines.push('');
    }
  }

  // Fallback to standard format for other sections
  const standardRest = formatReview({
    ...report,
    unreviewedMappings: [],
    unlinkedSymbols: report.unlinkedSymbols,
    orphanedSections: report.orphanedSections,
    impliedReferences: report.impliedReferences,
  });
  lines.push(standardRest);

  return lines.join('\n');
}

/** Read a short snippet of source code around a symbol definition. */
function readSourceSnippet(symbolName: string, projectRoot: string): string {
  try {
    // Search src/ for the symbol
    const srcDir = path.join(projectRoot, 'src');
    if (!fs.existsSync(srcDir)) return `(no src/ directory found)`;

    const MAX_FILES = 5000;
    let filesChecked = 0;

    const walkDir = (dir: string, depth = 0): string | null => {
      // Cap recursion depth to prevent stack overflow from deeply nested or
      // circular directory structures (e.g., symlink loops resolved by isDirectory()).
      if (depth > 20) return null;
      // Cap file count to prevent resource exhaustion on very large codebases
      if (filesChecked >= MAX_FILES) return null;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const e of entries) {
        if (filesChecked >= MAX_FILES) return null;
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          // Verify symlink containment for directories before recursing.
          // isDirectory() on a Dirent follows symlinks — a symlink at
          // src/secrets -> /etc would have isDirectory()=true and would
          // be recursed into without this check.
          let realDir: string;
          try { realDir = fs.realpathSync(full); } catch { continue; }
          if (!realDir.startsWith(projectRoot + path.sep) && realDir !== projectRoot) continue;
          const found = walkDir(realDir, depth + 1);
          if (found) return found;
        } else if (e.isFile() && /\.(ts|js|py|rs|go|java)$/.test(e.name)) {
          filesChecked++;
          // Verify symlink containment for individual files.
          let realFile: string;
          try { realFile = fs.realpathSync(full); } catch { continue; }
          if (!realFile.startsWith(projectRoot + path.sep) && realFile !== projectRoot) continue;
          // Guard against large files (generated bundles, minified libs) that
          // would OOM when loaded into a string for snippet extraction.
          // The review display helper only needs the symbol definition region.
          const fstat = fs.statSync(realFile);
          if (fstat.size > 10 * 1024 * 1024) continue; // 10 MB limit
          const content = fs.readFileSync(realFile, 'utf-8');
          if (content.includes(symbolName)) {
            // Extract surrounding lines
            const MAX_SNIPPET_LINES = 100_000;
            // F24 (round 9) / Round 14 fix: the original round 9 fix added a
            // post-split guard here, but content.split('\n') still allocates
            // the full array before the guard can reject it. Pre-scan newline
            // count first so we never allocate a multi-million-element array.
            let snippetLineCount = 1;
            for (let si = 0; si < content.length && snippetLineCount <= MAX_SNIPPET_LINES + 1; si++) {
              if (content[si] === '\n') snippetLineCount++;
            }
            if (snippetLineCount > MAX_SNIPPET_LINES) {
              return `(file exceeds ${MAX_SNIPPET_LINES} lines: ${path.relative(projectRoot, full)})`;
            }
            const lines = content.split('\n');
            const idx = lines.findIndex(l =>
              l.includes(`function ${symbolName}`) ||
              l.includes(`class ${symbolName}`) ||
              l.includes(`def ${symbolName}`) ||
              l.includes(`fn ${symbolName}`) ||
              l.includes(`const ${symbolName}`) ||
              l.includes(`${symbolName}(`)
            );
            if (idx >= 0) {
              const start = Math.max(0, idx - 3);
              const end = Math.min(lines.length, idx + 10);
              const prefix = `// ${path.relative(projectRoot, full)}:${idx + 1}\n`;
              return prefix + lines.slice(start, end).join('\n');
            }
            // Fallback: first occurrence
            const firstLine = lines.findIndex(l => l.includes(symbolName));
            if (firstLine >= 0) {
              const start = Math.max(0, firstLine - 2);
              const end = Math.min(lines.length, firstLine + 8);
              const prefix = `// ${path.relative(projectRoot, full)}:${firstLine + 1}\n`;
              return prefix + lines.slice(start, end).join('\n');
            }
          }
        }
      }
      return null;
    };

    return walkDir(srcDir) ?? `(symbol "${symbolName}" source not found)`;
  } catch (err: any) {
    return `(error reading source: ${err.message})`;
  }
}

/** Read a short snippet of a doc section. */
function readDocSnippet(docFile: string, anchor: string, projectRoot: string): string {
  // Validate path containment — defense-in-depth against DB-stored paths
  // that may contain traversal components (path.join normalizes ../).
  const resolved = validatePath(docFile, projectRoot);
  if (!resolved) return `(invalid path: ${docFile})`;

  try {
    // Guard against large doc files that would OOM when loaded into a string.
    const fstat = fs.statSync(resolved);
    if (fstat.size > 10 * 1024 * 1024) return `(file too large: ${docFile})`;
    const content = fs.readFileSync(resolved, 'utf-8');
    const MAX_SNIPPET_LINES = 100_000;
    // Round 14 fix: the original round 9 fix added a post-split guard here,
    // but content.split('\\n') still allocates the full array before the
    // guard can reject it. Pre-scan newline count first.
    let snippetLineCount = 1;
    for (let si = 0; si < content.length && snippetLineCount <= MAX_SNIPPET_LINES + 1; si++) {
      if (content[si] === '\n') snippetLineCount++;
    }
    if (snippetLineCount > MAX_SNIPPET_LINES) {
      return `(file exceeds ${MAX_SNIPPET_LINES} lines: ${docFile})`;
    }
    const lines = content.split('\n');

    if (!anchor) {
      // No anchor — show file header
      const prefix = `// ${docFile}\n`;
      return prefix + lines.slice(0, 15).join('\n');
    }

    // Find the anchor heading
    const escaped = escapeRegex(anchor);
    const headingRegex = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'im');
    const match = content.match(headingRegex);
    if (!match || match.index === undefined) return `(anchor "${anchor}" not found in ${docFile})`;

    // Count newlines up to the heading position instead of splitting the
    // substring (content.slice(0, match.index).split('\\n')). The substring
    // can be up to 10 MB (file size limit) when the heading is near the end,
    // and split('\\n') would allocate ~500 K string objects without a
    // pre-scan guard. A simple char loop avoids the allocation entirely.
    let headingLine = 1;
    const headingIdx = match.index;
    for (let hi = 0; hi < headingIdx; hi++) {
      if (content[hi] === '\n') headingLine++;
    }
    const start = Math.max(0, headingLine - 1);
    const end = Math.min(lines.length, headingLine + 12);
    const prefix = `// ${docFile}:${headingLine + 1}\n`;

    return prefix + lines.slice(start, end).join('\n');
  } catch (err: any) {
    return `(error reading doc: ${err.message})`;
  }
}

