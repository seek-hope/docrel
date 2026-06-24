import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';

export interface CheckReport {
  passed: boolean;
  staleDocs: Array<{
    id: string;
    file: string;
    anchor: string;
    doc_type: string;
    status: string;
    linkedSymbols: string[];
  }>;
  summary: string;
  error?: string;
}

export function docrelayCheck(db: Database.Database, strict = false): CheckReport {
  try {
    assertDbOpen(db);
    const staleRows = db.prepare(`
      SELECT d.id, d.file, d.anchor, d.doc_type, d.status, m.symbol_id
      FROM doc_sections d
      LEFT JOIN mappings m ON m.doc_id = d.id
      WHERE d.status = 'stale'
      ORDER BY d.id
    `).all() as Array<{ id: string; file: string; anchor: string; doc_type: string; status: string; symbol_id: string | null }>;

    // Group by doc_id to collect linked symbols per doc
    const docMap = new Map<string, {
      id: string; file: string; anchor: string; doc_type: string; status: string; linkedSymbols: string[];
    }>();
    for (const row of staleRows) {
      let entry = docMap.get(row.id);
      if (!entry) {
        entry = { id: row.id, file: row.file, anchor: row.anchor, doc_type: row.doc_type, status: row.status, linkedSymbols: [] };
        docMap.set(row.id, entry);
      }
      if (row.symbol_id) {
        entry.linkedSymbols.push(row.symbol_id);
      }
    }
    const staleDocs = [...docMap.values()];

    const passed = strict ? staleDocs.length === 0 : true;

    let summary: string;
    if (staleDocs.length === 0) {
      summary = 'All documentation is in sync.';
    } else {
      const uniqueFiles = [...new Set(staleDocs.map((d) => d.file))];
      summary = `${staleDocs.length} doc section(s) are stale across ${uniqueFiles.length} file(s): ${uniqueFiles.join(', ')}`;
    }

    return { passed, staleDocs, summary };
  } catch (err: any) {
    console.error('docrelayCheck failed:', err);
    // Database errors always indicate the check could not run — the result
    // is not trustworthy regardless of strict mode. Return passed: false
    // with a sanitized error message to prevent information disclosure.
    return {
      passed: false,
      staleDocs: [],
      summary: `Database error: check server logs for details.`,
      error: 'Database query error — check server logs for details',
    };
  }
}

/**
 * Format a CheckReport as human-readable markdown.
 */
export function formatCheckMarkdown(report: CheckReport): string {
  const lines: string[] = [];

  lines.push('## DocRelay Check');
  lines.push('');

  if (report.error) {
    lines.push(`**Error:** ${report.error}`);
    lines.push('');
    return lines.join('\n');
  }

  if (report.staleDocs.length === 0) {
    lines.push('All documentation is in sync.');
    lines.push('');
    return lines.join('\n');
  }

  const uniqueFiles = [...new Set(report.staleDocs.map((d) => d.file))];
  lines.push(`${report.staleDocs.length} doc section(s) stale across ${uniqueFiles.length} file(s):`);
  lines.push('');

  for (const doc of report.staleDocs) {
    const anchorLabel = doc.anchor ? `#${doc.anchor}` : '';
    lines.push(`### ${doc.file}${anchorLabel}`);
    lines.push('');
    lines.push(`- **Status:** ${doc.status}`);
    lines.push(`- **Type:** ${doc.doc_type}`);
    if (doc.linkedSymbols.length > 0) {
      lines.push(`- **Linked symbols:** ${doc.linkedSymbols.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a CheckReport as GitHub Actions workflow command annotations.
 * Outputs ::warning for each stale doc section and ::error if the
 * overall check fails (passed === false).
 */
export function formatCheckCI(report: CheckReport): string {
  const lines: string[] = [];

  for (const doc of report.staleDocs) {
    const escapedFile = doc.file.replace(/,/g, '%2C').replace(/\r?\n/g, '%0A');
    const escapedMessage = (doc.anchor
      ? `Section '${doc.anchor}' has stale documentation`
      : 'Documentation is stale'
    ).replace(/,/g, '%2C').replace(/\r?\n/g, '%0A');

    const lineParam = doc.linkedSymbols.length > 0
      // Use the first linked symbol to approximate a line reference
      // (the actual line is not tracked per-doc in check; we emit without line)
      ? ''
      : '';

    if (lineParam) {
      lines.push(`::warning file=${escapedFile}${lineParam}::${escapedMessage}`);
    } else {
      lines.push(`::warning file=${escapedFile}::${escapedMessage}`);
    }
  }

  if (!report.passed) {
    lines.push(`::error file=.::Documentation is out of sync with code`);
  }

  return lines.join('\n') + '\n';
}
