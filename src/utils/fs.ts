// Shared filesystem and string utilities used across sync modules.
import fs from 'node:fs';
import path from 'node:path';

/** Validate that `filePath` resolves inside `projectRoot` (prevents path traversal). */
export function validatePath(filePath: string, projectRoot: string): string | null {
  const resolved = path.resolve(projectRoot, filePath);
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
  } catch {
    // File doesn't exist yet — trust the resolved path
  }
  return resolved;
}

/** Escape regex-special characters in a string. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a global RegExp from a user string, escaping special chars. */
export function escapeRegexGlobal(str: string, maxLength = 200): RegExp {
  if (str.length > maxLength) return /(?!)a^/;
  return new RegExp(escapeRegex(str), 'g');
}
