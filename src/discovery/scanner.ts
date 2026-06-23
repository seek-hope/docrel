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
  let newSymbols = 0;
  let updatedSymbols = 0;

  for (const codeDir of config.code_dirs) {
    // Use codegraph_explore to discover all symbols in each code directory
    const result = await codegraph.explore(`symbols in ${codeDir}/`, 50);

    for (const sym of result.symbols) {
      const lang = detectLanguage(sym.file);
      const fqn = `${sym.file}::${sym.name}`;
      const id = symbolId(lang, fqn, sym.kind);
      const sig = contentHash(sym.signature ?? sym.name);

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
        });
        updatedSymbols++;
      }
    }
  }

  const total = db.prepare('SELECT COUNT(*) as count FROM symbols').get() as { count: number };

  return { totalSymbols: total.count, newSymbols, updatedSymbols };
}

function detectLanguage(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
    cs: 'csharp', cpp: 'cpp', c: 'c', swift: 'swift', kt: 'kotlin',
  };
  return langMap[ext ?? ''] ?? ext ?? 'unknown';
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
  return kindMap[kind.toLowerCase()] ?? 'function';
}
