import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
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
    closeDb();
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
