/**
 * Context injection helper — produces a markdown summary of DocRel status
 * suitable for injecting into an agent's system prompt or rules file.
 */
import type Database from 'better-sqlite3';
import { assertDbOpen } from '../db/connection.js';

export interface DocHealthContext {
  totalSymbols: number;
  linkedSymbols: number;
  linkedPercentage: number;
  totalDocs: number;
  syncedDocs: number;
  staleDocs: number;
  syncPercentage: number;
  staleDocFiles: string[];
  staleDocDetails: Array<{ file: string; anchor: string }>;
}

function queryHealthContext(db: Database.Database): DocHealthContext {
  assertDbOpen(db);

  return db.transaction(() => {
    const totalSymbols = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }).c;
    const linkedSymbols = (db.prepare(
      'SELECT COUNT(DISTINCT symbol_id) as c FROM mappings',
    ).get() as { c: number }).c;
    const totalDocs = (db.prepare('SELECT COUNT(*) as c FROM doc_sections').get() as { c: number }).c;
    const syncedDocs = (db.prepare(
      "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'in_sync'",
    ).get() as { c: number }).c;
    const staleDocs = (db.prepare(
      "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'stale'",
    ).get() as { c: number }).c;

    const staleRows = db.prepare(
      "SELECT file, anchor FROM doc_sections WHERE status = 'stale' ORDER BY file, anchor",
    ).all() as Array<{ file: string; anchor: string }>;

    const staleDocFiles = [...new Set(staleRows.map((r) => r.file))];

    return {
      totalSymbols,
      linkedSymbols,
      linkedPercentage: totalSymbols > 0 ? Math.round((linkedSymbols / totalSymbols) * 100) : 0,
      totalDocs,
      syncedDocs,
      staleDocs,
      syncPercentage: totalDocs > 0 ? Math.round((syncedDocs / totalDocs) * 100) : 0,
      staleDocFiles,
      staleDocDetails: staleRows,
    };
  })();
}

/**
 * Build a concise one-line DocRel health summary suitable for system-prompt
 * injection. Includes symbol counts, sync percentages, and stale doc names.
 *
 * Example output:
 * "DocRel status: 287 symbols tracked, 245 docs linked (85%), 12 docs stale.
 *  Stale docs: docs/api.md, README.md#setup. Run `docrel sync` to update."
 */
export function getDocHealthContext(db: Database.Database): string {
  try {
    const ctx = queryHealthContext(db);

    const parts: string[] = [];
    parts.push(`DocRel status: ${ctx.totalSymbols} symbols tracked`);

    if (ctx.totalSymbols > 0) {
      parts.push(`${ctx.linkedSymbols} docs linked (${ctx.linkedPercentage}%)`);
    }

    if (ctx.totalDocs > 0) {
      if (ctx.staleDocs > 0) {
        parts.push(`${ctx.staleDocs} docs stale`);
      } else {
        parts.push('all docs in sync');
      }
    } else {
      parts.push('no docs tracked');
    }

    let output = parts.join(', ') + '.';

    // List specific stale docs (up to 5 to keep it concise)
    if (ctx.staleDocs > 0 && ctx.staleDocDetails.length > 0) {
      const staleList = ctx.staleDocDetails.slice(0, 5).map((d) => {
        return d.anchor ? `${d.file}#${d.anchor}` : d.file;
      });
      output += ` Stale docs: ${staleList.join(', ')}`;

      if (ctx.staleDocDetails.length > 5) {
        output += ` and ${ctx.staleDocDetails.length - 5} more`;
      }

      output += '. Run \`docrel sync\` to update.';
    }

    return output;
  } catch (err: any) {
    // Return a safe fallback so context injection never crashes the agent
    console.error('DocRel: getDocHealthContext failed:', err instanceof Error ? err.message : err);
    return 'DocRel status: unavailable (database query failed).';
  }
}

/**
 * Return the full structured health context object for programmatic use.
 */
export function getDocHealthContextObject(db: Database.Database): DocHealthContext {
  try {
    return queryHealthContext(db);
  } catch (err: any) {
    console.error('DocRel: getDocHealthContextObject failed:', err instanceof Error ? err.message : err);
    return {
      totalSymbols: 0,
      linkedSymbols: 0,
      linkedPercentage: 0,
      totalDocs: 0,
      syncedDocs: 0,
      staleDocs: 0,
      syncPercentage: 0,
      staleDocFiles: [],
      staleDocDetails: [],
    };
  }
}
