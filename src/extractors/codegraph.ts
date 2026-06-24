import type { SymbolExtractor, ExtractedSymbol } from './interface.js';
import { CodegraphClient } from '../codegraph/client.js';

const CODEGRAPH_KIND_MAP: Record<string, ExtractedSymbol['kind']> = {
  function: 'function',
  method: 'method',
  func: 'function',
  class: 'class',
  struct: 'class',
  interface: 'interface',
  type: 'type',
  variable: 'variable',
  const: 'variable',
  let: 'variable',
  module: 'module',
  namespace: 'module',
};

/** Language map by file extension. */
const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
  cs: 'csharp', cpp: 'cpp', c: 'c', swift: 'swift', kt: 'kotlin',
};

function detectLanguage(file: string): string {
  const parts = file.split('.');
  if (parts.length <= 1) return 'unknown';
  const ext = parts[parts.length - 1]?.toLowerCase();
  if (!ext) return 'unknown';
  return LANG_MAP[ext] ?? ext;
}

function mapKind(kind: string): ExtractedSymbol['kind'] {
  const mapped = CODEGRAPH_KIND_MAP[kind.toLowerCase()];
  if (!mapped) {
    console.warn(`DocRelay: CodegraphExtractor received unknown symbol kind '${kind}' — defaulting to 'function'. Codegraph may have added new symbol types.`);
    return 'function';
  }
  return mapped;
}

export class CodegraphExtractor implements SymbolExtractor {
  readonly name = 'codegraph';

  constructor(private client: CodegraphClient, private maxFiles: number = 50) {}

  async extract(dir: string, _projectRoot: string, _since?: number): Promise<ExtractedSymbol[]> {
    // Convert relative path (e.g., "src") to a query for codegraph_explore.
    // Codegraph maintains its own index — incremental filtering is handled by
    // the codegraph server, not by file-level mtime checks.
    const query = `symbols in ${dir}/`;
    const result = await this.client.explore(query, this.maxFiles);

    return result.symbols.map((sym) => ({
      name: sym.name,
      kind: mapKind(sym.kind),
      file: sym.file,
      line: sym.line,
      signature: sym.signature,
      language: detectLanguage(sym.file),
    }));
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }
}
