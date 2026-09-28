import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations, SCHEMA_VERSION } from '../../src/db/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('getDb', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates docrelay.db inside .git directory', () => {
    getDb(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.git', 'docrelay.db'))).toBe(true);
  });

  it('returns the same connection on repeated calls', () => {
    const db1 = getDb(tmpDir);
    const db2 = getDb(tmpDir);
    expect(db1).toBe(db2);
  });

  it('sets WAL mode on the database', () => {
    const db = getDb(tmpDir);
    const result = db.pragma('journal_mode');
    expect(result).toEqual([{ journal_mode: 'wal' }]);
  });

  it('enables foreign keys', () => {
    const db = getDb(tmpDir);
    const result = db.pragma('foreign_keys');
    expect(result).toEqual([{ foreign_keys: 1 }]);
  });
});

describe('runMigrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all four tables: symbols, doc_sections, mappings, changelog', () => {
    const db = getDb(tmpDir);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain('symbols');
    expect(names).toContain('doc_sections');
    expect(names).toContain('mappings');
    expect(names).toContain('changelog');
  });

  it('v6 migration adds mappings.confidence, grandfathering legacy rows at 1.0', () => {
    const db = getDb(tmpDir);
    runMigrations(db);
    // Seed a mapping, then roll the schema back to v5 (drop the column).
    db.prepare("INSERT INTO symbols (id, name, kind) VALUES ('s1', 'login', 'function')").run();
    db.prepare("INSERT INTO doc_sections (id, file, anchor, doc_type) VALUES ('d1', 'docs/a.md', 'A', 'standalone')").run();
    db.prepare("INSERT INTO mappings (symbol_id, doc_id, rel_type, confidence) VALUES ('s1', 'd1', 'describes', 0.4)").run();
    db.exec('ALTER TABLE mappings DROP COLUMN confidence');
    db.pragma('user_version = 5');

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const row = db.prepare('SELECT confidence FROM mappings WHERE symbol_id = ?').get('s1') as { confidence: number };
    // Legacy rows are grandfathered at 1.0 — historical cascade behavior is
    // preserved until the next auto-link refresh records the true score.
    expect(row.confidence).toBe(1.0);
  });

  it('keeps an existing raw_signature column when re-running an old-version migration', () => {
    // Simulate a pre-V2 database: user_version reset, column already present.
    // The ALTER fails as a duplicate and the PRAGMA check must swallow it.
    const db = getDb(tmpDir);
    db.pragma('user_version = 0');
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const cols = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'raw_signature')).toBe(true);
  });

  it('adds raw_signature to a legacy symbols table that is missing it', () => {
    const db = getDb(tmpDir);
    runMigrations(db);
    db.exec('ALTER TABLE symbols DROP COLUMN raw_signature');
    db.pragma('user_version = 0');
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'raw_signature')).toBe(true);
  });

  it('rethrows the ALTER error when the column is genuinely missing', () => {
    const db = getDb(tmpDir);
    runMigrations(db);
    db.exec('ALTER TABLE symbols DROP COLUMN raw_signature');
    db.pragma('user_version = 0');
    const proxy = {
      pragma: (q: string, opts?: unknown) => db.pragma(q, opts as never),
      transaction: (fn: () => void) => db.transaction(fn),
      exec: (sql: string) => {
        if (sql.includes('ALTER TABLE symbols ADD COLUMN raw_signature')) throw new Error('disk gone');
        return db.exec(sql);
      },
      prepare: (sql: string) => db.prepare(sql),
    } as unknown as Database.Database;
    expect(() => runMigrations(proxy)).toThrow('disk gone');
  });

  it('is idempotent — running twice does not error', () => {
    const db = getDb(tmpDir);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('stores schema version in pragma', () => {
    const db = getDb(tmpDir);
    runMigrations(db);
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('mappings table has foreign keys to symbols and doc_sections', () => {
    const db = getDb(tmpDir);
    runMigrations(db);

    const foreignKeys = db
      .prepare("PRAGMA foreign_key_list('mappings')")
      .all() as { table: string }[];

    const tables = foreignKeys.map((fk) => fk.table);
    expect(tables).toContain('symbols');
    expect(tables).toContain('doc_sections');
  });
});
