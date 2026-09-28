// src/extractors/codegraph.ts — Symbol discovery backed by the CodeGraph index.
//
// Symbols are enumerated by reading CodeGraph's index database
// (.codegraph/codegraph.db) directly. An earlier version of this extractor
// used the codegraph_explore MCP tool — but explore is a relevance-ranked
// retrieval interface that returns a small, query-dependent subset of
// symbols (capped per response), not an enumeration API. Scans built on it
// captured a tiny partial symbol set, and `gc` then concluded hundreds of
// live symbols had been deleted. The index database is the same data source
// explore reads, queried exhaustively instead.
//
// Signatures and docstrings are re-captured from the source files with the
// exact routines the builtin extractor uses, so switching between extractors
// does not register as a repository-wide signature change.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SymbolExtractor, ExtractedSymbol } from './interface.js';
import { captureSignature, extractLeadingDocstring } from './builtin.js';
import type { CodegraphClient } from '../codegraph/client.js';

const CODEGRAPH_KIND_MAP: Record<string, ExtractedSymbol['kind']> = {
  function: 'function',
  method: 'method',
  func: 'function',
  class: 'class',
  struct: 'class',
  interface: 'interface',
  type: 'type',
  type_alias: 'type',
  enum: 'type',
  variable: 'variable',
  const: 'variable',
  constant: 'variable',
  let: 'variable',
  module: 'module',
  namespace: 'module',
};

/** Language map by file extension — fallback when an index row carries no language. */
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

/**
 * Index node kinds that are not DocRelay symbols (file structure, imports,
 *  class properties). Filtered in SQL so they never reach the scanner.

 */
const NON_SYMBOL_KINDS = "'import','file','property'";

interface IndexNodeRow {
  kind: string;
  name: string;
  file_path: string;
  language: string;
  start_line: number;
  signature: string | null;
}

/** Same defensive caps as the builtin extractor's file reader. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LINES = 100_000;

const INDEX_DB_REL = path.join('.codegraph', 'codegraph.db');

/** Normalize a configured code dir to an index file_path prefix ('src/').
 *  Returns null for "the whole repository" ('.', '', './'). */
function dirPrefix(dir: string): string | null {
  const trimmed = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.') return null;
  return trimmed + '/';
}

/**
 * Read all symbol-bearing index rows for `dir` from the codegraph index.
 * Throws an actionable error when the index is absent, unreadable, or has an
 * unexpected schema — the scanner records the directory as failed and the
 * zero-symbol fallback in scanWithFallback then re-scans with the builtin
 * extractor, so a broken index can never silently empty the symbol table.
 */
function readIndexNodes(projectRoot: string, dir: string): IndexNodeRow[] {
  const dbPath = path.join(projectRoot, INDEX_DB_REL);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`codegraph index not found at ${INDEX_DB_REL} — run \`codegraph init\` (or \`codegraph sync\`) to build it, or remove .codegraph/ to use the builtin extractor`);
  }
  let cg: Database.Database;
  try {
    cg = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`codegraph index at ${INDEX_DB_REL} could not be opened (${msg}) — the codegraph daemon may be rebuilding it; retry shortly, or remove .codegraph/ to use the builtin extractor`, { cause: err });
  }
  try {
    const prefix = dirPrefix(dir);
    const select = `SELECT kind, name, file_path, language, start_line, signature FROM nodes WHERE kind NOT IN (${NON_SYMBOL_KINDS})`;
    const order = ' ORDER BY file_path, start_line';
    let rows: IndexNodeRow[];
    try {
      rows = (prefix
        ? cg.prepare(`${select} AND substr(file_path, 1, ?) = ?${order}`).all(prefix.length, prefix)
        : cg.prepare(`${select}${order}`).all()) as IndexNodeRow[];
    } catch (err) {
      throw new Error(`codegraph index at ${INDEX_DB_REL} has an unrecognized schema (no nodes table?) — run \`codegraph sync\` to rebuild it, or remove .codegraph/ to use the builtin extractor`, { cause: err });
    }
    return rows;
  } finally {
    cg.close();
  }
}

/** Read a source file with the same guards as the builtin extractor.
 *  Returns undefined when the file cannot be safely read. */
function readSourceLines(absPath: string): string[] | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    const content = fs.readFileSync(fd, 'utf-8');
    // Pre-scan newline count before splitting (same OOM guard as builtin).
    let newlineCount = 1;
    for (let i = 0; i < content.length && newlineCount <= MAX_LINES + 1; i++) {
      if (content[i] === '\n') newlineCount++;
    }
    if (newlineCount > MAX_LINES) return undefined;
    return content.split('\n');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export class CodegraphExtractor implements SymbolExtractor {
  readonly name = 'codegraph';

  /**
   * @param client Used for availability checks; the same client serves
   *  point lookups (signatures, impact) during sync. Symbol enumeration
   *  itself reads the index database and does not use the MCP transport.
   */
  constructor(private client: CodegraphClient) {}

  async extract(dir: string, projectRoot: string, _since?: number): Promise<ExtractedSymbol[]> {
    // The codegraph index does not track per-file mtimes usable for
    // incremental filtering here; the scanner's incremental mode is a
    // builtin-extractor concern. Index reads are one SQL query, so a full
    // re-read is cheap.
    const rows = readIndexNodes(projectRoot, dir);
    if (rows.length === 0) return [];

    const byFile = new Map<string, IndexNodeRow[]>();
    for (const row of rows) {
      const list = byFile.get(row.file_path);
      if (list) list.push(row);
      else byFile.set(row.file_path, [row]);
    }

    const out: ExtractedSymbol[] = [];
    for (const [file, nodes] of byFile) {
      const lines = readSourceLines(path.join(projectRoot, file));
      if (!lines) {
        // The index references a file that is gone or unreadable — the index
        // is stale for this file. Skipping its nodes lets gc collect them
        // once the index is refreshed (or the deletion confirmed).
        console.warn(`DocRelay: CodegraphExtractor — skipping ${nodes.length} indexed symbol(s) in '${file}' (file unreadable, too large, or removed). Run \`codegraph sync\` to refresh the index.`);
        continue;
      }
      for (const node of nodes) {
        const language = node.language?.trim() || detectLanguage(file);
        let signature: string;
        let rawSignature: string | undefined;
        let docstring: string | undefined;
        if (Number.isInteger(node.start_line) && node.start_line >= 1 && node.start_line <= lines.length) {
          const cap = captureSignature(lines, node.start_line - 1);
          signature = cap.signature;
          rawSignature = cap.rawSignature;
          docstring = extractLeadingDocstring(lines, node.start_line - 1, language);
        } else {
          // Stale index row (file shrank since indexing). Keep the symbol
          // alive with the index's own signature fragment rather than
          // dropping it into gc's two-pass deletion path.
          signature = node.signature ?? '';
        }
        out.push({
          name: node.name,
          kind: mapKind(node.kind),
          file,
          line: node.start_line,
          signature,
          ...(rawSignature !== undefined ? { raw_signature: rawSignature } : {}),
          ...(docstring ? { docstring } : {}),
          language,
        });
      }
    }
    return out;
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }
}
