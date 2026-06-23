import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;
let currentRoot: string | null = null;

export function getDb(projectRoot: string): Database.Database {
  if (db && currentRoot === projectRoot) {
    return db;
  }

  closeDb();

  const gitDir = path.join(projectRoot, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const dbPath = path.join(gitDir, 'docrel.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  currentRoot = projectRoot;

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentRoot = null;
  }
}
