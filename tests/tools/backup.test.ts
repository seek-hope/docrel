import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pruneBackups } from '../../src/tools/backup.js';

describe('pruneBackups', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-backup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeBackups(count: number): string[] {
    const names: string[] = [];
    const base = Date.now() - count * 60_000;
    for (let i = 0; i < count; i++) {
      const name = `backup-2026-06-24T07-${String(i).padStart(2, '0')}-00-000Z.db`;
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, `db-${i}`);
      // Stagger mtimes so the oldest index is the oldest file
      const mtime = new Date(base + i * 60_000);
      fs.utimesSync(p, mtime, mtime);
      names.push(name);
    }
    return names;
  }

  it('keeps only the N newest backups and removes the rest', () => {
    const names = makeBackups(15);
    const { kept, removed } = pruneBackups(tmpDir, 10);
    expect(kept).toHaveLength(10);
    expect(removed).toHaveLength(5);
    // The 5 oldest (first created) must be gone
    for (const old of names.slice(0, 5)) {
      expect(fs.existsSync(path.join(tmpDir, old))).toBe(false);
    }
    for (const recent of names.slice(5)) {
      expect(fs.existsSync(path.join(tmpDir, recent))).toBe(true);
    }
  });

  it('does nothing when keep is 0 (pruning disabled)', () => {
    makeBackups(5);
    const { kept, removed } = pruneBackups(tmpDir, 0);
    expect(kept).toEqual([]);
    expect(removed).toEqual([]);
    expect(fs.readdirSync(tmpDir)).toHaveLength(5);
  });

  it('never touches non-backup files in the same directory', () => {
    makeBackups(3);
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'important.db'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'x');
    pruneBackups(tmpDir, 1);
    expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'important.db'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'notes.txt'))).toBe(true);
  });

  it('returns an empty result for a missing directory', () => {
    const { kept, removed } = pruneBackups(path.join(tmpDir, 'nope'), 5);
    expect(kept).toEqual([]);
    expect(removed).toEqual([]);
  });
});
