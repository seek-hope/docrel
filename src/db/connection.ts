import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const connections = new Map<string, Database.Database>();

export function getDb(projectRoot: string): Database.Database {
  const resolved = path.resolve(projectRoot);
  const existing = connections.get(resolved);
  if (existing) return existing;

  const gitDir = path.join(resolved, '.git');
  // Default to .docrel/ instead of .git/ to avoid creating a fake .git directory
  // when no git repo exists (git init would fail).
  let dbDir = path.join(resolved, '.docrel');

  try {
    if (fs.existsSync(gitDir)) {
      const stat = fs.statSync(gitDir);
      if (stat.isDirectory()) {
        dbDir = gitDir;
      } else {
        // .git is a file (worktree or submodule) — resolve the real git directory
        // Open fd first to prevent TOCTOU between stat and read
        let fd: number | undefined;
        try {
          fd = fs.openSync(gitDir, 'r');
          const content = fs.readFileSync(fd, 'utf-8');
          const match = content.match(/gitdir:\s*(.+)/);
          if (match?.[1]) {
            dbDir = path.resolve(resolved, match[1].trim());
            // Validate that resolved path is within project root
            const root = path.resolve(resolved);
            if (!dbDir.startsWith(root + path.sep) && dbDir !== root) {
              dbDir = path.join(resolved, '.docrel');
            }
          } else {
            dbDir = path.join(resolved, '.docrel');
          }
        } catch {
          dbDir = path.join(resolved, '.docrel');
        } finally {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
          }
        }
      }
    }
  } catch {
    // stat failed (e.g. EACCES) — fall back to .docrel
    dbDir = path.join(resolved, '.docrel');
  }

  let db: Database.Database;
  const dbPath = path.join(dbDir, 'docrel.db');

  try {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Restrictive permissions on the database and companion files
    try { fs.chmodSync(dbPath, 0o600); } catch { /* not critical */ }
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    try { if (fs.existsSync(walPath)) fs.chmodSync(walPath, 0o600); } catch { /* WAL may not exist yet */ }
    try { if (fs.existsSync(shmPath)) fs.chmodSync(shmPath, 0o600); } catch { /* SHM may not exist yet */ }
  } catch (err: any) {
    throw new Error(`Failed to initialize DocRel database at ${dbPath}: ${err.message}`);
  }

  connections.set(resolved, db);
  return db;
}

export function closeDb(projectRoot?: string): void {
  if (projectRoot) {
    const key = path.resolve(projectRoot);
    const db = connections.get(key);
    if (db) {
      db.close();
      connections.delete(key);
    }
  } else {
    for (const db of connections.values()) {
      db.close();
    }
    connections.clear();
  }
}
