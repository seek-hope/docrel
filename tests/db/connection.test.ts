import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
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
