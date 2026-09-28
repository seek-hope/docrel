import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { cachedStmt } from '../../src/db/statements.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('cachedStmt', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-stmt-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the same compiled statement for the same (db, sql) pair', () => {
    const sql = 'SELECT 1 AS x';
    const a = cachedStmt(db, sql);
    const b = cachedStmt(db, sql);
    expect(a).toBe(b);
    // And it actually runs.
    expect((a.get() as { x: number }).x).toBe(1);
  });

  it('compiles a separate statement per distinct SQL text and per database', () => {
    const s1 = cachedStmt(db, 'SELECT 1 AS x');
    const s2 = cachedStmt(db, 'SELECT 2 AS x');
    expect(s1).not.toBe(s2);

    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-stmt2-'));
    try {
      fs.mkdirSync(path.join(tmpDir2, '.git'), { recursive: true });
      const db2 = getDb(tmpDir2);
      runMigrations(db2);
      const s3 = cachedStmt(db2, 'SELECT 1 AS x');
      expect(s3).not.toBe(s1); // keyed per database handle
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('reuses statements safely across transactions', () => {
    const sql = "INSERT INTO metadata (key, value) VALUES ('t', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
    const stmt = cachedStmt(db, sql);
    db.transaction(() => {
      stmt.run('a');
      stmt.run('b');
    })();
    stmt.run('c'); // outside a transaction, same statement object
    const row = db.prepare("SELECT value FROM metadata WHERE key = 't'").get() as { value: string };
    expect(row.value).toBe('c');
    expect(cachedStmt(db, sql)).toBe(stmt);
  });
});
