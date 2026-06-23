import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const connections = new Map<string, Database.Database>();
const closedConnections = new WeakSet<Database.Database>();

/** Check whether a database connection is still usable. Call before every query
 *  in tools/sync/hooks modules to get a descriptive error instead of a raw
 *  "Database is closed" message. */
export function assertDbOpen(db: Database.Database): void {
  if (closedConnections.has(db)) {
    throw new Error('DocRel database connection has been closed. Re-initialize with getDb().');
  }
}

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
            const rawGitdir = match[1].trim();
            dbDir = path.resolve(resolved, rawGitdir);
            // Worktree gitdir resolves outside the worktree root (e.g. to
            // /main-repo/.git/worktrees/feature). That is expected — use the
            // main .git directory so all worktrees share the same database.
            // Accept paths that end with /.git/worktrees/<name> and derive
            // the main .git from them.
            const root = path.resolve(resolved);
            if (!dbDir.startsWith(root + path.sep) && dbDir !== root) {
              const worktreesIdx = dbDir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
              if (worktreesIdx > 0) {
                // Derive the main .git directory from the worktree path
                dbDir = dbDir.slice(0, worktreesIdx) + path.sep + '.git';
              } else {
                dbDir = path.join(resolved, '.docrel');
              }
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

    // Pre-check: if dbPath exists, verify it is a regular file (not a directory)
    if (fs.existsSync(dbPath) && !fs.statSync(dbPath).isFile()) {
      throw new Error(`Database path exists but is not a regular file`);
    }

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
    // Use relative path to avoid exposing absolute filesystem paths in error messages
    throw new Error(`Failed to initialize DocRel database in .docrel/: ${err.message}`);
  }

  connections.set(resolved, db);
  return db;
}

export function closeDb(projectRoot?: string): void {
  if (projectRoot) {
    const key = path.resolve(projectRoot);
    const db = connections.get(key);
    if (db) {
      closedConnections.add(db);
      try { db.close(); } catch { /* already closed */ }
      connections.delete(key);
    }
  } else {
    for (const db of connections.values()) {
      closedConnections.add(db);
      try { db.close(); } catch { /* already closed */ }
    }
    connections.clear();
  }
}
