// src/discovery/scanner.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { upsertSymbol, markSignatureChanged } from '../db/symbols.js';
import { symbolId, contentHash } from '../utils/hash.js';

/** File extension → language name mapping (module-level, created once). */
const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
  cs: 'csharp', cpp: 'cpp', c: 'c', swift: 'swift', kt: 'kotlin',
};

/** Escape :: in FQN components to prevent symbol ID collisions. */
function escFqn(s: string): string {
  return s.replace(/::/g, '%3A%3A');
}

/** Codegraph symbol kind → canonical DocRel kind mapping (module-level). */
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
}

export async function scanProject(
  codegraph: CodegraphClient,
  db: Database.Database,
  config: DocRelConfig,
): Promise<ScanReport> {
  if (config.code_dirs.length === 0) {
    console.warn('Warning: No code directories configured. Set code_dirs in .docrel/config.yaml');
    return { totalSymbols: 0, newSymbols: 0, updatedSymbols: 0 };
  }

  let newSymbols = 0;
  let updatedSymbols = 0;
  const scannedIds = new Set<string>();

  for (const codeDir of config.code_dirs) {
    try {
      // Use codegraph_explore to discover all symbols in each code directory
      const result = await codegraph.explore(`symbols in ${codeDir}/`, 50);

      for (const sym of result.symbols) {
        const lang = detectLanguage(sym.file);
        // Include line number in the FQN to disambiguate same-named symbols
        // in different scopes within the same file (e.g., method foo in class A
        // and method foo in class B, both in src/index.ts).
        // Escape the :: separator in file and name components to prevent
        // symbol ID collisions when a file path or symbol name contains ::
        // (e.g., C++ namespace-qualified names or Rust turbofish expressions).
        const fqn = `${escFqn(sym.file)}::${sym.line}::${escFqn(sym.name)}`;
        const id = symbolId(lang, fqn, sym.kind);
        const sig = contentHash(sym.signature ?? '');
        const rawSig = sym.signature ?? '';

        scannedIds.add(id);

        const existing = db.prepare('SELECT id, signature FROM symbols WHERE id = ?').get(id) as
          | { id: string; signature: string }
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
          // Record changelog entry so docrelDiff and the changelog table
          // surface what changed between scans.
          markSignatureChanged(db, id, existing.signature, sig, rawSig);
          updatedSymbols++;
        }
      }
    } catch (err: any) {
      const safeName = codeDir.replace(/[\x00-\x1f\x7f]/g, '');
      console.warn(`DocRel: Failed to scan directory '${safeName}': ${err.message}`);
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
  db.prepare(
    "INSERT INTO metadata (key, value, updated_at) VALUES ('last_scan_at', datetime('now'), datetime('now')) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run();

  return { totalSymbols: existingSymbols.size, newSymbols, updatedSymbols };
}

function detectLanguage(file: string): string {
  const parts = file.split('.');
  // Files without extensions (Makefile, Dockerfile, .gitignore, etc.)
  // should not use the filename as a language label.
  if (parts.length <= 1) return 'unknown';

  const ext = parts.pop()?.toLowerCase();
  if (!ext) return 'unknown';

  return LANG_MAP[ext] ?? ext;
}

function mapKind(kind: string): 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable' | 'unknown' {
  const mapped = KIND_MAP[kind.toLowerCase()];
  if (!mapped) {
    console.warn(`DocRel: Unknown symbol kind '${kind}' — storing as 'unknown'`);
    return 'unknown';
  }
  return mapped;
}
