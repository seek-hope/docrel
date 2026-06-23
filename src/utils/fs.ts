// Shared filesystem and string utilities used across sync modules.
import fs from 'node:fs';
import path from 'node:path';

/** Validate that `filePath` resolves inside `projectRoot` (prevents path traversal). */
export function validatePath(filePath: string, projectRoot: string): string | null {
  // Reject empty file paths to prevent returning the project root itself
  if (!filePath || filePath.trim() === '') return null;

  const resolved = path.resolve(projectRoot, filePath);
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
  } catch {
    // File doesn't exist yet — but check for dangling symlinks to prevent bypass
    try {
      const lstat = fs.lstatSync(resolved);
      if (lstat.isSymbolicLink()) return null; // dangling symlink — reject
    } catch {
      // lstat also failed — path genuinely doesn't exist, trust the resolved path
    }
  }
  return resolved;
}

/** Escape regex-special characters in a string. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a global RegExp from a user string, escaping special chars.
 *  Returns null when the string exceeds maxLength — callers MUST check for
 *  null to distinguish "no match possible" from "search was aborted". */
export function escapeRegexGlobal(str: string, maxLength = 200): RegExp | null {
  if (str.length > maxLength) {
    console.warn(`DocRel: escapeRegexGlobal aborted — string length ${str.length} exceeds max ${maxLength}`);
    return null;
  }
  return new RegExp(escapeRegex(str), 'g');
}
