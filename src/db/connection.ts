import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const connections = new Map<string, Database.Database>();

export function getDb(projectRoot: string): Database.Database {
  const resolved = path.resolve(projectRoot);
  const existing = connections.get(resolved);
  if (existing) return existing;

  const gitDir = path.join(resolved, '.git');
  let dbDir = gitDir;

  if (fs.existsSync(gitDir)) {
    if (!fs.statSync(gitDir).isDirectory()) {
      // .git is a file (worktree or submodule) — resolve the real git directory
      try {
        const content = fs.readFileSync(gitDir, 'utf-8');
        const match = content.match(/gitdir:\s*(.+)/);
        if (match?.[1]) {
          dbDir = path.resolve(resolved, match[1].trim());
        } else {
          // Fallback: place db next to .git file
          dbDir = path.join(resolved, '.docrel');
        }
      } catch {
        dbDir = path.join(resolved, '.docrel');
      }
    }
  }

  let db: Database.Database;
  const dbPath = path.join(dbDir, 'docrel.db');

  try {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
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
