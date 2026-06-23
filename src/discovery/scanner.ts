// src/discovery/scanner.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { upsertSymbol } from '../db/symbols.js';
import { symbolId, contentHash } from '../utils/hash.js';

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
        const fqn = `${sym.file}::${sym.name}`;
        const id = symbolId(lang, fqn, sym.kind);
        const sig = contentHash(sym.signature ?? sym.name);
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
          updatedSymbols++;
        }
      }
    } catch (err: any) {
      console.warn(`DocRel: Failed to scan directory '${codeDir}': ${err.message}`);
    }
  }

  // Use scannedIds count instead of COUNT(*) to avoid counting symbols
  // from other projects or prior scans that this scan did not touch.
  const existingSymbols = new Set<string>();
  if (scannedIds.size > 0) {
    const existingRows = db.prepare(
      'SELECT id FROM symbols WHERE id IN (' + [...scannedIds].map(() => '?').join(',') + ')'
    ).all(...scannedIds) as Array<{ id: string }>;
    for (const row of existingRows) existingSymbols.add(row.id);
  }

  return { totalSymbols: existingSymbols.size + newSymbols, newSymbols, updatedSymbols };
}

function detectLanguage(file: string): string {
  const parts = file.split('.');
  // Files without extensions (Makefile, Dockerfile, .gitignore, etc.)
  // should not use the filename as a language label.
  if (parts.length <= 1) return 'unknown';

  const ext = parts.pop()?.toLowerCase();
  if (!ext) return 'unknown';

  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
    cs: 'csharp', cpp: 'cpp', c: 'c', swift: 'swift', kt: 'kotlin',
  };
  return langMap[ext] ?? ext;
}

function mapKind(kind: string): 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable' {
  const kindMap: Record<string, ReturnType<typeof mapKind>> = {
    function: 'function', method: 'function', func: 'function',
    class: 'class', struct: 'class',
    module: 'module', namespace: 'module',
    api_endpoint: 'api_endpoint', endpoint: 'api_endpoint', route: 'api_endpoint',
    type: 'type', interface: 'interface',
    variable: 'variable', const: 'variable', let: 'variable',
  };
  const mapped = kindMap[kind.toLowerCase()];
  if (!mapped) {
    console.warn(`DocRel: Unknown symbol kind '${kind}' — treating as 'function'`);
    return 'function';
  }
  return mapped;
}
