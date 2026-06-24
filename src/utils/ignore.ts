import fs from 'node:fs';
import path from 'node:path';

const IGNORE_FILE = '.docrelayignore';

interface CompiledPattern {
  regex: RegExp;
  negated: boolean;
}

let cache: { projectRoot: string; patterns: CompiledPattern[] } | null = null;

/**
 * Clear the cached compiled patterns. Useful in tests and after config changes.
 */
export function clearIgnoreCache(): void {
  cache = null;
}

/**
 * Parse a .docrelayignore file and return compiled regex patterns.
 * Supports gitignore-style syntax:
 *   - `#` comments and blank lines
 *   - `*` matches anything except /
 *   - `**` matches zero or more directories
 *   - Leading `!` negates the pattern
 */
function compilePatterns(projectRoot: string): CompiledPattern[] {
  if (cache && cache.projectRoot === projectRoot) {
    return cache.patterns;
  }

  const ignorePath = path.join(projectRoot, IGNORE_FILE);
  const patterns: CompiledPattern[] = [];

  let raw: string;
  try {
    // Guard against malicious .docrelayignore files that could OOM the process.
    // An ignore file is typically under 1KB; 1MB is extremely generous.
    const ignoreStat = fs.statSync(ignorePath);
    if (ignoreStat.size > 1_048_576) {
      console.warn('DocRelay: .docrelayignore exceeds 1MB — ignoring');
      cache = { projectRoot, patterns };
      return patterns;
    }
    raw = fs.readFileSync(ignorePath, 'utf-8');
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`DocRelay: cannot read .docrelayignore:`, (err as NodeJS.ErrnoException)?.message ?? err);
    }
    cache = { projectRoot, patterns };
    return patterns;
  }

  // Guard against pathological .docrelayignore files with excessive lines
  // (e.g., 1 MB file of single-char lines). The file is size-limited at 1 MB
  // above, but without a line-count cap the split and loop could process
  // ~500 K iterations. Real ignore files typically have < 50 lines.
  const MAX_IGNORE_LINES = 10_000;
  let ignoreLineCount = 1;
  for (let li = 0; li < raw.length && ignoreLineCount <= MAX_IGNORE_LINES + 1; li++) {
    if (raw[li] === '\n') ignoreLineCount++;
  }
  if (ignoreLineCount > MAX_IGNORE_LINES) {
    console.warn(`DocRelay: .docrelayignore has ${ignoreLineCount} lines, exceeding ${MAX_IGNORE_LINES} — ignoring`);
    cache = { projectRoot, patterns };
    return patterns;
  }

  for (const line of raw.split('\n')) {
    let trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    // Handle negation
    let negated = false;
    if (trimmed.startsWith('!')) {
      negated = true;
      trimmed = trimmed.slice(1);
      if (trimmed.length === 0) continue;
    }

    // Convert gitignore pattern to regex
    let regexStr = '^';
    const isDirectoryPattern = trimmed.endsWith('/');
    if (isDirectoryPattern) {
      trimmed = trimmed.slice(0, -1);
    }

    // Leading slash: anchor to project root
    let anchored = false;
    if (trimmed.startsWith('/')) {
      anchored = true;
      trimmed = trimmed.slice(1);
    }

    // Build regex from remaining pattern
    let i = 0;
    while (i < trimmed.length) {
      if (trimmed[i] === '*' && trimmed[i + 1] === '*') {
        // ** matches zero or more directories (including none)
        if (trimmed[i + 2] === '/') {
          regexStr += '(.*/)?';
          i += 3;
        } else if (i + 2 === trimmed.length) {
          regexStr += '.*';
          i += 2;
        } else {
          regexStr += '[^/]*';
          i += 1;
        }
      } else if (trimmed[i] === '*') {
        regexStr += '[^/]*';
        i++;
      } else if (trimmed[i] === '?') {
        regexStr += '[^/]';
        i++;
      } else {
        regexStr += escapeRegexChar(trimmed[i]);
        i++;
      }
    }

    if (anchored) {
      regexStr += '(?:/.*)?$';
    } else {
      regexStr += '(?:/.*)?$';
      // If pattern contains a /, it's anchored relative
      if (trimmed.includes('/')) {
        // Already built the anchored-relative form
      } else {
        // Pattern without / matches at any level — prepend .*/
        regexStr = '^(?:.*/)?' + regexStr.slice(1);
      }
    }

    if (isDirectoryPattern) {
      // Only match directories (paths that end with / in their pattern context)
      // For our purposes, any path that's inside the directory matches
      regexStr = regexStr.replace(/\$$/, '(?:/.*)?$');
    }

    try {
      patterns.push({ regex: new RegExp(regexStr), negated });
    } catch {
      console.warn(`DocRelay: .docrelayignore: skipping invalid regex pattern: ${line}`);
    }
  }

  cache = { projectRoot, patterns };
  return patterns;
}

function escapeRegexChar(ch: string): string {
  const special = '.+^${}()|[]\\';
  if (special.includes(ch)) return '\\' + ch;
  return ch;
}

/**
 * Check whether a file path is ignored by .docrelayignore.
 * @param filePath - Relative path from project root
 * @param projectRoot - Absolute project root path
 */
export function isIgnored(filePath: string, projectRoot: string): boolean {
  const patterns = compilePatterns(projectRoot);

  // Normalize to forward slashes for consistent matching
  const normalized = filePath.replace(/\\/g, '/');

  let ignored = false;
  for (const { regex, negated } of patterns) {
    if (regex.test(normalized)) {
      ignored = !negated;
    }
  }

  return ignored;
}
