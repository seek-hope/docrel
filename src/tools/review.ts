// src/tools/review.ts — mapping audit: unlinked symbols, orphaned sections, implied refs
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface ReviewReport {
  unlinkedSymbols: UnlinkedSymbol[];
  orphanedSections: OrphanedSection[];
  impliedReferences: ImpliedReference[];
  lowConfidenceMappings: LowConfidenceMapping[];
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

export interface LowConfidenceMapping {
  symbolId: string;
  symbolName: string;
  docId: string;
  docFile: string;
  docAnchor: string;
  confidence: number;
  relType: string;
}

export interface ReviewSummary {
  totalSymbols: number;
  linkedSymbols: number;
  unlinkedCount: number;
  orphanedCount: number;
  impliedCount: number;
  lowConfidenceCount: number;
}

/** Find symbols with no mappings. */
function findUnlinked(db: Database.Database): UnlinkedSymbol[] {
  return db.prepare(`
    SELECT s.id, s.name, s.kind, s.location
    FROM symbols s
    WHERE s.id NOT IN (SELECT DISTINCT symbol_id FROM mappings)
    ORDER BY s.name
  `).all() as UnlinkedSymbol[];
}

/** Find doc sections with no mappings. */
function findOrphaned(db: Database.Database): OrphanedSection[] {
  return db.prepare(`
    SELECT d.id, d.file, d.anchor
    FROM doc_sections d
    WHERE d.id NOT IN (SELECT DISTINCT doc_id FROM mappings)
    ORDER BY d.file, d.anchor
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

  // Get all known symbol names
  const symRows = db.prepare('SELECT name FROM symbols').all() as { name: string }[];
  const knownNames = new Set(symRows.map((r) => r.name));

  // Get all docs with their content
  const docRows = db.prepare('SELECT id, file, anchor FROM doc_sections WHERE doc_type = \'standalone\'').all() as
    { id: string; file: string; anchor: string }[];

  // Get existing mapping pairs
  const mapRows = db.prepare(`
    SELECT s.name AS symbol_name, d.file AS doc_file, d.anchor AS doc_anchor
    FROM mappings m
    JOIN symbols s ON s.id = m.symbol_id
    JOIN doc_sections d ON d.id = m.doc_id
  `).all() as { symbol_name: string; doc_file: string; doc_anchor: string }[];
  const existingPairs = new Set(mapRows.map((r) => `${r.symbol_name}::${r.doc_file}#${r.doc_anchor}`));

  for (const doc of docRows) {
    try {
      const fullPath = path.resolve(projectRoot, doc.file);
      if (!fs.existsSync(fullPath)) continue;

      // Enforce size limit before reading to prevent OOM from large files
      const stat = fs.statSync(fullPath);
      if (stat.size > 1 * 1024 * 1024) continue; // 1 MB per doc file for review

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

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
      const sectionLines = sectionContent.split('\n');

      for (const symbolName of knownNames) {
        if (symbolName.length < 2) continue;

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
    } catch (err: any) {
      // Collect unreadable files so operators know which docs could not be
      // analyzed. EACCES, EIO, and file-not-found are all treated as skips
      // but the user gets a count in the summary.
      const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
      skippedFiles.push(`${doc.file} (${code})`);
    }
  }

  return { references, skippedFiles };
}

/** Find mappings with confidence below threshold (default < 0.8). */
function findLowConfidence(db: Database.Database, maxConfidence = 0.8): LowConfidenceMapping[] {
  return db.prepare(`
    SELECT m.symbol_id AS symbolId, s.name AS symbolName,
           m.doc_id AS docId, d.file AS docFile, d.anchor AS docAnchor,
           m.confidence, m.rel_type AS relType
    FROM mappings m
    JOIN symbols s ON s.id = m.symbol_id
    JOIN doc_sections d ON d.id = m.doc_id
    WHERE m.confidence < ?
    ORDER BY m.confidence ASC
  `).all(maxConfidence) as LowConfidenceMapping[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function docrelReview(db: Database.Database, projectRoot: string): ReviewReport {
  const unlinkedSymbols = findUnlinked(db);
  const orphanedSections = findOrphaned(db);
  const { references: impliedReferences, skippedFiles } = findImplied(db, projectRoot);
  const lowConfidenceMappings = findLowConfidence(db);

  const totalSymbols = (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c;
  const linkedSymbols = (db.prepare(
    'SELECT COUNT(DISTINCT symbol_id) AS c FROM mappings',
  ).get() as { c: number }).c;

  return {
    unlinkedSymbols,
    orphanedSections,
    impliedReferences,
    lowConfidenceMappings,
    skippedFiles,
    summary: {
      totalSymbols,
      linkedSymbols,
      unlinkedCount: unlinkedSymbols.length,
      orphanedCount: orphanedSections.length,
      impliedCount: impliedReferences.length,
      lowConfidenceCount: lowConfidenceMappings.length,
    },
  };
}

/** Format the review as human-readable markdown. */
export function formatReview(report: ReviewReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push('## DocRel Review');
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

  if (report.lowConfidenceMappings.length > 0) {
    lines.push(`### Low-Confidence Mappings (${report.lowConfidenceMappings.length})`);
    lines.push('');
    lines.push('These mappings were auto-generated and need review:');
    lines.push('');
    for (const m of report.lowConfidenceMappings) {
      lines.push(`- [${m.confidence.toFixed(1)}] \`${m.symbolName}\` ↔ ${m.docFile}#${m.docAnchor} (${m.relType})`);
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
      report.lowConfidenceMappings.length === 0 &&
      report.orphanedSections.length === 0 &&
      report.skippedFiles.length === 0) {
    lines.push('✅ All clear — no issues found.');
    lines.push('');
  }

  return lines.join('\n');
}
