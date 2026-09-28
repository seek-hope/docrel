import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { prepareCommitMsg, installHooks } from '../../src/git/hooks.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK_NAMES = ['pre-commit', 'post-commit', 'pre-push', 'prepare-commit-msg'];

describe('prepareCommitMsg', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-hooksmsg-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('summarizes an empty database', () => {
    expect(prepareCommitMsg(db)).toBe(
      'DocRelay: 0 symbols changed, 0 docs synced, 0 docs flagged for review',
    );
  });

  it('counts synced and stale docs', () => {
    upsertDocSection(db, { id: docSectionId('docs/a.md', ''), file: 'docs/a.md', anchor: '', doc_type: 'standalone', status: 'in_sync' });
    upsertDocSection(db, { id: docSectionId('docs/b.md', ''), file: 'docs/b.md', anchor: '', doc_type: 'standalone', status: 'stale' });

    expect(prepareCommitMsg(db)).toBe(
      'DocRelay: 0 symbols changed, 1 docs synced, 1 docs flagged for review',
    );
  });
});

describe('installHooks', () => {
  let tmpDir: string;
  let binDir: string;
  let fakeBin: string;
  let savedArgv1: string | undefined;
  let savedPath: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-hooks-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

    // Fake docrelay binary under a .npm/ path so it passes the allowed-prefix
    // validation in installHooks.
    binDir = path.join(tmpDir, '.npm', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fakeBin = path.join(binDir, 'docrelay');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho "docrelay/0.0.0-test linux-x64 node-v22"\n', { mode: 0o755 });

    savedArgv1 = process.argv[1];
    savedPath = process.env.PATH;
    // Force the PATH-lookup branch and make `which docrelay` find the fake.
    process.argv[1] = undefined as unknown as string;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv[1] = savedArgv1 as string;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs all four hooks as executables with fail-open guards', () => {
    installHooks(tmpDir);

    for (const name of HOOK_NAMES) {
      const p = path.join(tmpDir, '.git', 'hooks', name);
      const stat = fs.statSync(p);
      expect(stat.mode & 0o111).not.toBe(0);
      const content = fs.readFileSync(p, 'utf-8');
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain('project not initialized');
      expect(content).toContain(fakeBin);
    }
    const preCommit = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(preCommit).toContain('check --strict');
    const postCommit = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
    expect(postCommit).toContain('scan --incremental');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('hooks installed'));
  });

  it('skips existing hooks without --force and overwrites them with --force', () => {
    const preCommitPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(preCommitPath), { recursive: true });
    fs.writeFileSync(preCommitPath, '#!/bin/sh\necho custom\n', { mode: 0o755 });

    installHooks(tmpDir, false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pre-commit hook already exists'));
    expect(fs.readFileSync(preCommitPath, 'utf-8')).toContain('custom');

    installHooks(tmpDir, true);
    expect(fs.readFileSync(preCommitPath, 'utf-8')).toContain('check --strict');
  });

  it('resolves worktree .git files to the main repository hooks directory', () => {
    // Fake a main repo with a worktree: worktree/.git is a file pointing at
    // main/.git/worktrees/feature — hooks must land in main/.git/hooks.
    const mainRepo = path.join(tmpDir, 'main');
    fs.mkdirSync(path.join(mainRepo, '.git', 'worktrees', 'feature'), { recursive: true });
    const worktree = path.join(tmpDir, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(mainRepo, '.git', 'worktrees', 'feature')}\n`,
      'utf-8',
    );

    installHooks(worktree);

    const hookPath = path.join(mainRepo, '.git', 'hooks', 'pre-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain('check --strict');
  });

  it('falls back to .docrelay/hooks when .git is a plain file', () => {
    const plain = path.join(tmpDir, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, '.git'), 'not a gitdir reference\n', 'utf-8');

    installHooks(plain);

    expect(fs.existsSync(path.join(plain, '.docrelay', 'hooks', 'pre-commit'))).toBe(true);
  });

  it('shell-quotes binary paths containing single quotes', () => {
    // Directory with a single quote in its name, still under a .npm/ prefix.
    const quoteDir = path.join(tmpDir, ".npm", "it's");
    fs.mkdirSync(quoteDir, { recursive: true });
    const quoteBin = path.join(quoteDir, 'docrelay');
    fs.writeFileSync(quoteBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    process.env.PATH = `${quoteDir}${path.delimiter}${binDir}${path.delimiter}${savedPath ?? ''}`;

    installHooks(tmpDir);

    const preCommit = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    // Standard shell quoting: '...it'\''s...'
    expect(preCommit).toContain("'\\''");
    expect(preCommit).not.toContain(`'${quoteBin}'`);
  });

  it('throws when docrelay cannot be located on PATH', () => {
    process.env.PATH = path.join(tmpDir, 'empty-bin');

    expect(() => installHooks(tmpDir)).toThrow(/Cannot locate docrelay binary/);
  });

  it('uses argv[1] directly when it resolves under an allowed prefix', () => {
    process.argv[1] = fakeBin;

    installHooks(tmpDir);

    const preCommit = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(preCommit).toContain(fakeBin);
    expect(preCommit).toContain('check --strict');
  });

  it('rejects an argv[1] path outside the allowed install prefixes', () => {
    const outsideDir = path.join(tmpDir, 'fake-cli');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideBin = path.join(outsideDir, 'cli.js');
    fs.writeFileSync(outsideBin, '// not docrelay\n', 'utf-8');
    process.argv[1] = outsideBin;

    expect(() => installHooks(tmpDir)).toThrow(/Cannot locate docrelay binary.*unexpected path/);
  });

  it('rejects an argv[1] binary that fails --version', () => {
    const brokenDir = path.join(tmpDir, '.npm', 'broken');
    fs.mkdirSync(brokenDir, { recursive: true });
    const brokenBin = path.join(brokenDir, 'docrelay');
    fs.writeFileSync(brokenBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.argv[1] = brokenBin;

    expect(() => installHooks(tmpDir)).toThrow(/Resolved docrelay binary.*does not appear to work/);
  });

  it('throws when which returns an empty result', () => {
    const fakeWhich = path.join(binDir, 'which');
    fs.writeFileSync(fakeWhich, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(() => installHooks(tmpDir)).toThrow(/Cannot locate docrelay binary: docrelay not found on PATH/);
  });

  it('rejects a PATH-resolved binary outside the allowed install prefixes', () => {
    const evilDir = path.join(tmpDir, 'evil');
    fs.mkdirSync(evilDir, { recursive: true });
    const evilBin = path.join(evilDir, 'docrelay');
    fs.writeFileSync(evilBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const fakeWhich = path.join(binDir, 'which');
    fs.writeFileSync(fakeWhich, `#!/bin/sh\necho "${evilBin}"\n`, { mode: 0o755 });

    expect(() => installHooks(tmpDir)).toThrow(/Cannot locate docrelay binary.*unexpected path/);
  });

  it('rejects a PATH-resolved binary that fails --version', () => {
    const brokenDir = path.join(tmpDir, '.npm', 'broken');
    fs.mkdirSync(brokenDir, { recursive: true });
    const brokenBin = path.join(brokenDir, 'docrelay');
    fs.writeFileSync(brokenBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const fakeWhich = path.join(binDir, 'which');
    fs.writeFileSync(fakeWhich, `#!/bin/sh\necho "${brokenBin}"\n`, { mode: 0o755 });

    expect(() => installHooks(tmpDir)).toThrow(/Cannot locate docrelay binary.*does not appear to work/);
  });

  it('uses an in-root gitdir from a worktree .git file verbatim', () => {
    // Some worktree/submodule layouts keep the real gitdir INSIDE the project
    // root; in that case it is used directly instead of deriving the main .git.
    const wt = path.join(tmpDir, 'wt-inner');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: inner-git\n', 'utf-8');

    installHooks(wt);

    expect(fs.existsSync(path.join(wt, 'inner-git', 'hooks', 'pre-commit'))).toBe(true);
  });

  it('throws a clear error when the hooks directory cannot be created', () => {
    // .git/hooks exists as a plain file — mkdirSync cannot create a dir there.
    fs.writeFileSync(path.join(tmpDir, '.git', 'hooks'), 'not a directory\n', 'utf-8');

    expect(() => installHooks(tmpDir)).toThrow(/Failed to create hooks directory/);
  });

  it('rolls back partially installed hooks when a later hook write fails', () => {
    // post-commit exists as a DIRECTORY: with force=true the write fails with
    // EISDIR after pre-commit was already written — the rollback must remove it.
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), { recursive: true });

    expect(() => installHooks(tmpDir, true)).toThrow(/Removed 1 partially installed hooks/);
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });
});
