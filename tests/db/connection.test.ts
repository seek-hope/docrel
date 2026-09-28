import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, closeAllDbs, dbBusyTimeoutMs } from '../../src/db/connection.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('getDb git-directory resolution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-dbconn-'));
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a worktree .git file to the main repository .git directory', () => {
    const mainRepo = path.join(tmpDir, 'main');
    fs.mkdirSync(path.join(mainRepo, '.git', 'worktrees', 'feature'), { recursive: true });
    const worktree = path.join(tmpDir, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(mainRepo, '.git', 'worktrees', 'feature')}\n`,
      'utf-8',
    );

    getDb(worktree);

    expect(fs.existsSync(path.join(mainRepo, '.git', 'docrelay.db'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.docrelay', 'docrelay.db'))).toBe(false);
  });

  it('uses an in-root gitdir from a .git file verbatim', () => {
    const root = path.join(tmpDir, 'sub');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: inner-git\n', 'utf-8');

    getDb(root);

    expect(fs.existsSync(path.join(root, 'inner-git', 'docrelay.db'))).toBe(true);
  });

  it('falls back to .docrelay when the gitdir escapes and is not a worktree path', () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const root = path.join(tmpDir, 'proj');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${elsewhere}\n`, 'utf-8');

    getDb(root);

    expect(fs.existsSync(path.join(root, '.docrelay', 'docrelay.db'))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, 'docrelay.db'))).toBe(false);
  });

  it('falls back to .docrelay when the .git file has no gitdir reference', () => {
    const root = path.join(tmpDir, 'proj');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), 'not a gitdir file\n', 'utf-8');

    getDb(root);

    expect(fs.existsSync(path.join(root, '.docrelay', 'docrelay.db'))).toBe(true);
  });

  it('falls back to .docrelay when the .git file exceeds 4096 bytes', () => {
    const root = path.join(tmpDir, 'proj');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${'x'.repeat(5000)}\n`, 'utf-8');

    getDb(root);

    expect(fs.existsSync(path.join(root, '.docrelay', 'docrelay.db'))).toBe(true);
  });

  it('restricts permissions on pre-existing WAL/SHM companions', () => {
    const root = path.join(tmpDir, 'proj');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    // Simulate leftover companions from an earlier crashed process.
    fs.writeFileSync(path.join(root, '.git', 'docrelay.db-wal'), '', { mode: 0o644 });
    fs.writeFileSync(path.join(root, '.git', 'docrelay.db-shm'), '', { mode: 0o644 });

    getDb(root);

    const walMode = fs.statSync(path.join(root, '.git', 'docrelay.db-wal')).mode & 0o777;
    const shmMode = fs.statSync(path.join(root, '.git', 'docrelay.db-shm')).mode & 0o777;
    expect(walMode).toBe(0o600);
    expect(shmMode).toBe(0o600);
  });

  it('warns and falls back to .docrelay when .git exists but is inaccessible', () => {
    const root = path.join(tmpDir, 'proj');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((p: any, flags: any): number => {
      if (String(p) === path.join(root, '.git')) {
        throw Object.assign(new Error("EACCES: permission denied, open '.git'"), { code: 'EACCES' });
      }
      return realOpen(p, flags);
    });
    try {
      getDb(root);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('inaccessible (EACCES)'));
      expect(fs.existsSync(path.join(root, '.docrelay', 'docrelay.db'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.git', 'docrelay.db'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to .docrelay without a permission warning for other open failures', () => {
    const root = path.join(tmpDir, 'proj');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((p: any, flags: any): number => {
      if (String(p) === path.join(root, '.git')) {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return realOpen(p, flags);
    });
    try {
      getDb(root);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('inaccessible'));
      expect(fs.existsSync(path.join(root, '.docrelay', 'docrelay.db'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('closeDb closes and evicts the cached connection', () => {
    const root = path.join(tmpDir, 'proj');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const a = getDb(root);
    closeDb(root);
    expect(() => a.prepare('SELECT 1').get()).toThrow();
    const b = getDb(root);
    expect(b).not.toBe(a);
  });

  it('closeDb is a no-op for a project that was never opened', () => {
    expect(() => closeDb(path.join(tmpDir, 'never-opened'))).not.toThrow();
  });

  it('sanitizes the project path from initialization errors', () => {
    const root = path.join(tmpDir, 'proj');
    // A directory where the database file should be — opening it as a
    // SQLite database fails.
    fs.mkdirSync(path.join(root, '.git', 'docrelay.db'), { recursive: true });

    // better-sqlite3's open failure is generic, so the sanitizer mainly
    // guarantees the contract that no absolute project path leaks.
    expect(() => getDb(root)).toThrow(/Failed to initialize DocRelay database/);
    try {
      getDb(root);
      expect.unreachable();
    } catch (err: any) {
      expect(String(err.message)).not.toContain(root);
    }
  });
});

describe('getDb busy timeout', () => {
  let tmpDir: string;
  const saved = process.env.DOCRELAY_DB_TIMEOUT;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-busy-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DOCRELAY_DB_TIMEOUT;
    else process.env.DOCRELAY_DB_TIMEOUT = saved;
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to 5000ms when DOCRELAY_DB_TIMEOUT is unset', () => {
    delete process.env.DOCRELAY_DB_TIMEOUT;
    expect(dbBusyTimeoutMs()).toBe(5000);
    const db = getDb(tmpDir);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('honors a valid DOCRELAY_DB_TIMEOUT override', () => {
    process.env.DOCRELAY_DB_TIMEOUT = '15000';
    expect(dbBusyTimeoutMs()).toBe(15000);
    const db = getDb(tmpDir);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(15000);
  });

  it('warns and falls back to 5000 on an invalid override', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DOCRELAY_DB_TIMEOUT = 'soon';
    expect(dbBusyTimeoutMs()).toBe(5000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DOCRELAY_DB_TIMEOUT'));
  });
});
