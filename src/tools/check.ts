import type Database from 'better-sqlite3';

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
}

export function docrelCheck(db: Database.Database, strict = false): CheckReport {
  const staleRows = db.prepare(`
    SELECT d.id, d.file, d.anchor, d.doc_type, d.status
    FROM doc_sections d
    WHERE d.status = 'stale'
  `).all() as Array<{ id: string; file: string; anchor: string; doc_type: string; status: string }>;

  const staleDocs = staleRows.map((row) => {
    const symbols = db.prepare(
      'SELECT symbol_id FROM mappings WHERE doc_id = ?',
    ).all(row.id) as Array<{ symbol_id: string }>;

    return {
      ...row,
      linkedSymbols: symbols.map((s) => s.symbol_id),
    };
  });

  const passed = strict ? staleDocs.length === 0 : true;

  let summary: string;
  if (staleDocs.length === 0) {
    summary = 'All documentation is in sync.';
  } else {
    const files = [...new Set(staleDocs.map((d) => d.file))].join(', ');
    summary = `${staleDocs.length} doc section(s) are stale across ${staleDocs.length > 0 ? [...new Set(staleDocs.map(d => d.file))].length : 0} file(s): ${files}`;
  }

  return { passed, staleDocs, summary };
}
