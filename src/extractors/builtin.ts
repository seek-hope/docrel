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
        stack.push(fullPath);
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
  let content: string;
  try {
    content = fs.readFileSync(realPath, 'utf-8');
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`DocRelay: cannot read source file ${realPath}:`, err instanceof Error ? err.message : err);
    }
    return [];
  }

  const ext = path.extname(filePath).toLowerCase();
  const rules = RULES_BY_EXT[ext];
  if (!rules || rules.length === 0) return [];

  const language = detectLanguage(filePath);
  const relativePath = path.relative(projectRoot, filePath);
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

        // Capture signature: first line of the definition
        const signature = line.trim();

        symbols.push({
          name,
          kind: rule.kind,
          file: relativePath,
          line: lineIdx + 1,
          signature,
          language,
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
      if (since !== undefined) {
        try {
          const st = fs.statSync(file);
          if (st.mtimeMs <= since) continue;
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
