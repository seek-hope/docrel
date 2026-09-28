// src/tools/backup.ts — backup directory maintenance.
import fs from 'node:fs';
import path from 'node:path';

// Only files created by `doc-relay backup` itself match this pattern —
// pruning must never touch user files that happen to live in the same dir.
const BACKUP_NAME_RE = /^backup-.+\.db$/;

export interface PruneResult {
  kept: string[];
  removed: string[];
}

/**
 * Keep only the `keep` most recent backup-*.db files in `dir`, deleting the
 * rest. `keep` < 1 disables pruning. Files that vanish between readdir and
 * unlink (concurrent cleanup) are skipped silently.
 */
export function pruneBackups(dir: string, keep: number): PruneResult {
  const result: PruneResult = { kept: [], removed: [] };
  if (keep < 1) return result;

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => BACKUP_NAME_RE.test(f));
  } catch {
    return result; // directory unreadable — nothing to prune
  }

  const entries: Array<{ name: string; path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      entries.push({ name, path: p, mtimeMs: fs.statSync(p).mtimeMs });
    } catch { /* vanished between readdir and stat — skip */ }
  }

  // Newest first; name tiebreak for identical mtimes (ISO names sort chrono).
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  entries.forEach((entry, idx) => {
    if (idx < keep) {
      result.kept.push(entry.name);
      return;
    }
    try {
      fs.unlinkSync(entry.path);
      result.removed.push(entry.name);
    } catch { /* best-effort — a locked file should not fail the backup */ }
  });
  return result;
}
