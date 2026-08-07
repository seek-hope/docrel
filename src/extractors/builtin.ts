import fs from 'node:fs';
import path from 'node:path';
import type { SymbolExtractor, ExtractedSymbol } from './interface.js';

/** File extension => language mapping. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
  cs: 'csharp', cpp: 'cpp', c: 'c', swift: 'swift', kt: 'kotlin',
};

/** Extensions we know how to parse with regex. */
const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.go',
  '.rs',
]);

function detectLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return EXT_LANG[ext.slice(1)] ?? ext;
}

/**
 * Per-language regex patterns for symbol extraction.
 * Each pattern produces: name, kind, and optionally a signature line.
 *
 * For TypeScript/JavaScript:
 *   function name, class name, const name =, interface name, type name,
 *   export function/class/const
 * For Python: def name, class name
 * For Go: func name, type name struct, type name interface
 * For Rust: fn name, struct name, impl name, trait name, enum name
 */
interface RegexRule {
  regex: RegExp;
  kind: ExtractedSymbol['kind'];
}

const RULES_BY_EXT: Record<string, RegexRule[]> = {
  '.ts': makeTsRules(),
  '.tsx': makeTsRules(),
  '.js': makeTsRules(),
  '.jsx': makeTsRules(),
  '.mjs': makeTsRules(),
  '.cjs': makeTsRules(),
  '.py': [
    // def name
    { regex: /^\s*(?:async\s+)?def\s+(\w[\w\d_]*)\s*\(/m, kind: 'function' },
    // class name
    { regex: /^\s*class\s+(\w[\w\d_]*)/m, kind: 'class' },
  ],
  '.go': [
    // func name (including method receivers: func (r *T) Name)
    { regex: /^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w[\w\d_]*)\s*\(/m, kind: 'function' },
    // type name struct
    { regex: /^\s*type\s+(\w[\w\d_]*)\s+struct\s*\{/m, kind: 'class' },
    // type name interface
    { regex: /^\s*type\s+(\w[\w\d_]*)\s+interface\s*\{/m, kind: 'interface' },
  ],
  '.rs': [
    // fn name
    { regex: /^\s*(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w[\w\d_]*)\s*[<(]/m, kind: 'function' },
    // struct name
    { regex: /^\s*(?:pub\s+)?struct\s+(\w[\w\d_]*)/m, kind: 'class' },
    // trait name
    { regex: /^\s*(?:pub\s+)?trait\s+(\w[\w\d_]*)/m, kind: 'interface' },
    // enum name
    { regex: /^\s*(?:pub\s+)?enum\s+(\w[\w\d_]*)/m, kind: 'type' },
    // impl name (including impl Trait for Type)
    { regex: /^\s*impl\s+(?:\w+\s+for\s+)?(\w[\w\d_]*)/m, kind: 'class' },
  ],
};

function makeTsRules(): RegexRule[] {
  return [
    // export (default)? (async)? function name
    { regex: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w[\w\d_$]*)/m, kind: 'function' },
    // export (default)? class name
    { regex: /^\s*(?:export\s+(?:default\s+)?)?class\s+(\w[\w\d_$]*)/m, kind: 'class' },
    // export const name =
    { regex: /^\s*export\s+const\s+(\w[\w\d_$]*)\s*[:=]/m, kind: 'variable' },
    // const name = (arrow function / function expression)
    { regex: /^\s*(?:export\s+)?const\s+(\w[\w\d_$]*)\s*=\s*(?:async\s*)?(?:\(|function)/m, kind: 'function' },
    // (export)? interface name
    { regex: /^\s*(?:export\s+)?interface\s+(\w[\w\d_$]*)/m, kind: 'interface' },
    // (export)? type name =
    { regex: /^\s*(?:export\s+)?type\s+(\w[\w\d_$]*)\s*[=<]/m, kind: 'type' },
    // (export)? (async)? function name (non-export top-level)
    { regex: /^\s*(?:async\s+)?function\s+(\w[\w\d_$]*)/m, kind: 'function' },
  ];
}

/**
 * Capture a complete (possibly multi-line) symbol signature starting at
 * `startIdx`. Accumulates lines until the parenthesis depth returns to
 * balanced (<= 0) AND a structural terminator (`{`, `=>` or `;`) is seen.
 * Caps at `maxLines` as a defensive upper bound against pathological input.
 *
 * Returns the folded single-line form (backward compatible with the old
 * single-line behavior) plus the raw multi-line text.
 */
function captureSignature(
  lines: string[],
  startIdx: number,
  maxLines = 10,
): { signature: string; rawSignature: string } {
  const rawParts: string[] = [];
  let depth = 0;
  let done = false;

  for (let i = startIdx; i < Math.min(lines.length, startIdx + maxLines); i++) {
    const ln = lines[i];
    rawParts.push(ln);
    for (const ch of ln) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const trimmed = ln.trim();
    if (depth <= 0 && (trimmed.includes('{') || trimmed.includes('=>') || trimmed.includes(';'))) {
      done = true;
      break;
    }
  }
  void done; // rawParts is non-empty by construction; done indicates timely termination

  // Fold interior whitespace to a single line; preserves single-line results exactly.
  const signature = rawParts.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim();
  const rawSignature = rawParts.join('\n');
  return { signature, rawSignature };
}

/** Collect all file paths recursively under a directory. */
function collectFiles(dir: string, projectRoot: string, maxFiles = 5000): string[] {
  const result: string[] = [];
  const absDir = path.resolve(projectRoot, dir);
  // Containment check: ensure resolved path stays within projectRoot.
  // Without this, config.yaml can specify code_dirs: ['../../../etc'] to
  // recursively read arbitrary filesystem paths.
  const root = path.resolve(projectRoot);
  if (!absDir.startsWith(root + path.sep) && absDir !== root) return result;
  // Resolve symlinks and re-verify containment to prevent symlink bypass
  let realDir: string;
  try {
    realDir = fs.realpathSync(absDir);
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`DocRelay: cannot resolve code directory ${absDir}:`, err instanceof Error ? err.message : err);
    }
    return result;
  }
  if (!realDir.startsWith(root + path.sep) && realDir !== root) return result;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realDir);
  } catch (err: any) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      console.warn(`DocRelay: code directory not found: ${absDir}`);
    } else {
      console.warn(`DocRelay: cannot access code directory ${absDir}: ${err instanceof Error ? err.message : err} (${code ?? 'unknown'})`);
    }
    return result;
  }
  if (!stat.isDirectory()) {
    return result;
  }

  const stack: string[] = [realDir];
  const seenDirs = new Set<string>();
  while (stack.length > 0 && result.length < maxFiles) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err: any) {
      console.warn(`DocRelay: cannot read directory ${current}:`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const entry of entries) {
      if (result.length >= maxFiles) break;
      const fullPath = path.join(current, entry.name);
      // Skip hidden directories and common non-code dirs
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
            entry.name === 'dist' || entry.name === 'build' || entry.name === 'target' ||
            entry.name === '__pycache__' || entry.name === 'vendor') {
          continue;
        }
        // Resolve symlinks to detect directory cycles. entry.isDirectory()
        // follows symlinks, so a symlink loop (A->B->A) would cause repeated
        // entries — track real paths and skip already-visited directories.
        let realPath: string;
        try { realPath = fs.realpathSync(fullPath); } catch { continue; }
        if (seenDirs.has(realPath)) continue;
        seenDirs.add(realPath);
        stack.push(realPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          result.push(fullPath);
        }
      }
    }
  }
  return result;
}

/**
 * Extract a leading documentation block for a symbol. Returns undefined when
 * there is no qualifying docstring.
 *
 * The function is exported for unit testing.
 */
export function extractLeadingDocstring(lines: string[], defIdx: number, language: string): string | undefined {
  if (language === 'typescript' || language === 'javascript') {
    return extractTsJsDoc(lines, defIdx);
  }
  if (language === 'python') {
    return extractPythonDocstring(lines, defIdx);
  }
  return undefined;
}

/**
 * Extract the contiguous JSDoc block (`/** ... *​/`) immediately preceding the
 * symbol definition at `defIdx`. Ordinary single-line comments, blank lines
 * (at most one) and plain `/* ... *​/` (license headers) are skipped, so they
 * are never mistaken for a docstring. Returns undefined when no JSDoc block
 * qualifies.
 */
function extractTsJsDoc(lines: string[], defIdx: number): string | undefined {
  // Walk back over blank lines (max 1) and single-line comments above the def.
  let i = defIdx - 1;
  let blanks = 0;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '') { blanks++; if (blanks > 1) return undefined; i--; continue; }
    if (t.startsWith('//')) { i--; continue; }
    break;
  }
  if (i < 0) return undefined;

  const end = i;
  const collected: string[] = [];
  let isDoc = false;
  let j = end;

  while (j >= 0) {
    const raw = lines[j];
    const t = raw.trimStart();
    if (j === end) {
      // Closing line must contain the block terminator.
      if (!t.includes('*/')) return undefined;
      // A single-line `/** ... *​/ ` block both opens and closes here.
      if (t.startsWith('/**')) {
        collected.unshift(raw);
        isDoc = true;
        break;
      }
      // Multi-line block: this is only the closing line.
      collected.unshift(raw);
    } else if (t.startsWith('/**')) {
      // Opening line of the JSDoc block — this is the start.
      collected.unshift(raw);
      isDoc = true;
      break;
    } else {
      // Interior line of the block: allow ` * ...` continuation lines and
      // inner whitespace. Anything else ends the candidate block.
      if (t.includes('*/')) break; // stop before an earlier block close
      const trimmed = raw.trim();
      if (trimmed === '') { j--; continue; }
      if (!t.startsWith('*') && !t.includes('/*')) return undefined;
      if (t.includes('/*') && !t.startsWith('/**')) break; // non-doc block above
      collected.unshift(raw);
    }
    j--;
  }

  return isDoc ? collected.join('\n') : undefined;
}

/**
 * Extract a Python function/class docstring — the string literal that is the
 * first statement in the body. Returns undefined when the body starts with
 * anything other than a `"""..."""` / `'''...'''` literal.
 */
function extractPythonDocstring(lines: string[], defIdx: number): string | undefined {
  for (let i = defIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^("""|''')/);
    if (!m) return undefined; // first statement is not a string literal docstring
    const quote = m[1]; // the triple quote (""" or ''')
    const rest = trimmed.slice(3);
    // Single-line docstring: closing triple-quote on the same line.
    if (rest.includes(quote)) return trimmed;
    // Multi-line docstring: collect until the closing triple-quote.
    const collected = [trimmed];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      collected.push(l);
      if (l.includes(quote)) break;
    }
    return collected.join('\n');
  }
  return undefined;
}

/** Extract symbols from a single file using regex patterns. */
function extractFromFile(filePath: string, projectRoot: string): ExtractedSymbol[] {
  // Defend against symlinks inside legitimate code directories
  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
    const root = path.resolve(projectRoot);
    if (!realPath.startsWith(root + path.sep) && realPath !== root) return [];
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`DocRelay: cannot resolve source file ${filePath}:`, err instanceof Error ? err.message : err);
    }
    return [];
  }
  // Guard against large files (generated bundles, minified vendor libs) that
  // would OOM when loaded into a string. All other file readers in the codebase
  // (inline.ts, standalone.ts, doc-scanner.ts, generated.ts, review.ts) cap at 10MB.
  let content: string;
  let fd: number | undefined;
  try {
    // Use fd-based read to avoid TOCTOU between stat and readFileSync
    fd = fs.openSync(realPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return [];
    content = fs.readFileSync(fd, 'utf-8');
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`DocRelay: cannot read source file ${realPath}:`, err instanceof Error ? err.message : err);
    }
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const rules = RULES_BY_EXT[ext];
  if (!rules || rules.length === 0) return [];

  const language = detectLanguage(filePath);
  const relativePath = path.relative(projectRoot, filePath);
  // Guard against pathological files with millions of short lines that
  // would allocate a massive array from split. Pre-scan newline count
  // before splitting to avoid OOM from the array allocation itself.
  // (Round 14: the original round 5 fix used a post-split guard which
  // does not prevent the split from allocating the array.)
  const MAX_LINES = 100_000;
  let newlineCount = 1;
  for (let i = 0; i < content.length && newlineCount <= MAX_LINES + 1; i++) {
    if (content[i] === '\n') newlineCount++;
  }
  if (newlineCount > MAX_LINES) return [];
  const lines = content.split('\n');
  const symbols: ExtractedSymbol[] = [];
  const seen = new Set<string>();

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const rule of rules) {
      // Reset regex to avoid sticky state
      rule.regex.lastIndex = 0;
      const match = rule.regex.exec(line);
      if (match?.[1]) {
        const name = match[1];
        const key = `${lineIdx}:${name}:${rule.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Capture the complete signature, including continuation lines for
        // multi-line definitions. For single-line definitions this produces
        // exactly the previous behavior (one trimmed line).
        const { signature, rawSignature } = captureSignature(lines, lineIdx);

        // Capture a leading documentation block (JSDoc / Python docstring) if
        // present, so the scanner can build an `inline` doc_section for it.
        const docstring = extractLeadingDocstring(lines, lineIdx, language);

        symbols.push({
          name,
          kind: rule.kind,
          file: relativePath,
          line: lineIdx + 1,
          signature,
          raw_signature: rawSignature,
          language,
          ...(docstring ? { docstring } : {}),
        });
      }
    }
  }

  return symbols;
}

export class BuiltinExtractor implements SymbolExtractor {
  readonly name = 'builtin';

  async extract(dir: string, projectRoot: string, since?: number): Promise<ExtractedSymbol[]> {
    const files = collectFiles(dir, projectRoot);
    const allSymbols: ExtractedSymbol[] = [];

    for (const file of files) {
      // Incremental scan: skip files not modified since the last scan.
      // A 1s tolerance is added because `since` is derived from a UTC-second
      // timestamp while mtimeMs has sub-second / local precision — a file
      // written in the same second as the previous scan could otherwise be
      // incorrectly skipped (missed scan).
      if (since !== undefined) {
        try {
          const st = fs.statSync(file);
          if (st.mtimeMs <= since + 1000) continue;
        } catch { continue; }
      }
      const syms = extractFromFile(file, projectRoot);
      allSymbols.push(...syms);
    }

    // Deduplicate by (file, line, name, kind)
    const seen = new Set<string>();
    return allSymbols.filter((s) => {
      const key = `${s.file}:${s.line}:${s.name}:${s.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async isAvailable(): Promise<boolean> {
    // Builtin extractor is always available — no external dependencies.
    return true;
  }
}
