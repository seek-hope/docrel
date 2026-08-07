// src/sync/scan-fallback.ts — decision logic for falling back to the builtin
// extractor when the active (e.g. codegraph) extractor yields zero symbols.
import fs from 'node:fs';
import path from 'node:path';

// Source-file extensions that DocRelay scans for symbols. Used to decide whether
// a zero-symbol scan result is genuinely empty or the extractor silently failed
// (e.g. codegraph binary present but its `explore` output was unparseable).
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.kt', '.rb', '.php', '.cs', '.cpp', '.hpp', '.c', '.h',
]);

/** Whether any configured code_dir actually contains source files on disk. */
export function hasSourceFiles(codeDirs: string[], projectRoot: string): boolean {
  for (const dir of codeDirs) {
    const resolved = path.resolve(projectRoot, dir);
    let stat;
    try { stat = fs.statSync(resolved); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const stack: string[] = [resolved];
    const seen = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
              entry.name === 'dist' || entry.name === 'build' || entry.name === 'target' ||
              entry.name === '__pycache__' || entry.name === 'vendor') continue;
          const full = path.join(current, entry.name);
          let real: string;
          try { real = fs.realpathSync(full); } catch { continue; }
          if (seen.has(real)) continue;
          seen.add(real);
          stack.push(real);
        } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Decide whether to fall back to the builtin extractor after a scan completed
 * with zero symbols. Falls back only when:
 *   - the extractor produced 0 symbols,
 *   - we are not already using the builtin extractor, and
 *   - the configured code directories do contain real source files on disk.
 */
export function shouldFallbackToBuiltin(
  totalSymbols: number,
  extractorName: string,
  codeDirs: string[],
  projectRoot: string,
): boolean {
  return totalSymbols === 0 &&
    extractorName !== 'builtin' &&
    hasSourceFiles(codeDirs, projectRoot);
}
