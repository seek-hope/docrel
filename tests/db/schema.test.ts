import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations, SCHEMA_VERSION } from '../../src/db/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('getDb', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates docrel.db inside .git directory', () => {
    const db = getDb(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.git', 'docrel.db'))).toBe(true);
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
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
