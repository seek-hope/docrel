import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanDocs } from '../../src/discovery/doc-scanner.js';

describe('scanDocs missing-path handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-docscan-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports nonexistent configured paths as skippedMissing, not failedFiles', async () => {
    const { report } = await scanDocs(['docs', 'README.md'], tmpDir);
    expect(report.skippedMissing).toEqual(['docs', 'README.md']);
    expect(report.failedFiles).toEqual([]);
  });

  it('still parses existing dirs while skipping missing ones', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs'));
    fs.writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '# Title\n\nSome content.\n');
    const { sections, report } = await scanDocs(['docs', 'missing-dir'], tmpDir);
    expect(report.skippedMissing).toEqual(['missing-dir']);
    expect(report.failedFiles).toEqual([]);
    expect(sections.length).toBeGreaterThan(0);
  });
});

describe('scanDocs containment & edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-docsec-'));
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '# Guide\n\n## install\n\nDo it.\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects doc_dirs that escape the project root', async () => {
    const { report, sections } = await scanDocs(['../outside', 'docs'], tmpDir);
    expect(report.failedFiles).toContain('../outside');
    expect(sections.length).toBeGreaterThanOrEqual(1); // docs still scanned
  });

  it('rejects a symlinked doc dir that resolves outside the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-outside-'));
    fs.writeFileSync(path.join(outside, 'leak.md'), '# Secret\n', 'utf-8');
    fs.rmSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.symlinkSync(outside, path.join(tmpDir, 'docs'));

    const { report, sections } = await scanDocs(['docs'], tmpDir);
    expect(report.failedFiles).toEqual(['docs']);
    expect(sections).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('accepts a single file as a doc_dir (e.g. README.md)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project\n\n## usage\n\nUse it.\n', 'utf-8');
    const { report, sections } = await scanDocs(['README.md'], tmpDir);
    expect(report.totalFiles).toBe(1);
    expect(sections.length).toBeGreaterThanOrEqual(1);
    expect(report.failedFiles).toEqual([]);
  });

  it('silently skips a single-file doc_dir with an unsupported extension', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'project: x\n', 'utf-8');
    const { report, sections } = await scanDocs(['config.yaml'], tmpDir);
    expect(report.totalFiles).toBe(1); // counted as visited
    expect(sections).toEqual([]);
    expect(report.failedFiles).toEqual([]);
  });

  it('skips a single-file doc_dir that is a symlink escaping the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-outfile-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), '# Secret\n', 'utf-8');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(tmpDir, 'link.md'));

    const { sections } = await scanDocs(['link.md'], tmpDir);
    expect(sections).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('skips a single-file doc_dir matched by .docrelayignore', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'README.md\n', 'utf-8');
    const { report, sections } = await scanDocs(['README.md'], tmpDir);
    expect(report.totalFiles).toBe(0);
    expect(sections).toEqual([]);
  });

  it('does not walk directories matched by .docrelayignore', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'drafts'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'drafts', 'wip.md'), '# WIP\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'docs/drafts/\n', 'utf-8');
    const { sections } = await scanDocs(['docs'], tmpDir);
    expect(sections.every((s) => !s.file.includes('drafts'))).toBe(true);
    expect(sections.length).toBeGreaterThanOrEqual(1); // guide.md still found
  });

  it('collects only supported doc extensions when walking', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'notes.txt'), 'plain text\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'spec.rst'), 'Spec\n====\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'page.html'), '<h1>Hi</h1>\n', 'utf-8');
    const { report } = await scanDocs(['docs'], tmpDir);
    // guide.md + spec.rst + page.html — notes.txt never collected
    expect(report.totalFiles).toBe(3);
  });

  it('skips hidden dirs and node_modules while walking', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', '.hidden', 'x.md'), '# X\n', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'docs', 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'node_modules', 'pkg', 'README.md'), '# Pkg\n', 'utf-8');
    const { sections, report } = await scanDocs(['docs'], tmpDir);
    expect(report.totalFiles).toBe(1);
    expect(sections.every((s) => s.file === 'docs/guide.md')).toBe(true);
  });

  it('reports doc files exceeding the 10 MB size limit as failed', async () => {
    const bigPath = path.join(tmpDir, 'docs', 'big.md');
    fs.writeFileSync(bigPath, '# Big\n', 'utf-8');
    fs.truncateSync(bigPath, 11 * 1024 * 1024); // sparse — no real 11 MB write
    const { report } = await scanDocs(['docs'], tmpDir);
    expect(report.failedFiles).toContain('docs/big.md');
    // The small file still parsed fine.
    expect(report.totalSections).toBeGreaterThanOrEqual(1);
  });
});

describe('scanDocs permission & special-file edges', () => {
  let tmpDir: string;
  // EACCES-based tests are meaningless when running as root (root bypasses
  // permission bits) — skip them there (e.g. some container CI setups).
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-docperm-'));
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '# Guide\n', 'utf-8');
  });

  afterEach(() => {
    // Restore permissions so rmSync can clean up.
    try { fs.chmodSync(path.join(tmpDir, 'docs'), 0o755); } catch { /* already gone */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(isRoot)('reports a doc dir whose parent denies traversal as failed', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'sub'), { recursive: true });
    fs.chmodSync(path.join(tmpDir, 'docs'), 0o000);
    const { report } = await scanDocs(['docs/sub'], tmpDir);
    expect(report.failedFiles).toEqual(['docs/sub']);
  });

  it.skipIf(isRoot)('warns and continues when a walked directory is unreadable', async () => {
    fs.chmodSync(path.join(tmpDir, 'docs'), 0o000);
    // The dir itself resolves and stats fine; only readdir is denied.
    const { report, sections } = await scanDocs(['docs'], tmpDir);
    expect(sections).toEqual([]);
    expect(report.failedFiles).toEqual([]); // unreadable dirs are warnings, not failures
  });

  it.skipIf(isRoot)('reports an unreadable doc file as failed and keeps going', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'noperm.md'), '# Nope\n', 'utf-8');
    fs.chmodSync(path.join(tmpDir, 'docs', 'noperm.md'), 0o000);
    const { report } = await scanDocs(['docs'], tmpDir);
    expect(report.failedFiles).toContain('docs/noperm.md');
    expect(report.totalSections).toBeGreaterThanOrEqual(1); // guide.md parsed
    fs.chmodSync(path.join(tmpDir, 'docs', 'noperm.md'), 0o644);
  });

  it.runIf(process.platform !== 'win32')('ignores a non-regular file passed as doc_dir', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(tmpDir, 'pipe')]);
    const { report, sections } = await scanDocs(['pipe'], tmpDir);
    expect(sections).toEqual([]);
    expect(report.totalFiles).toBe(0);
  });

  it('skips individual files matched by .docrelayignore while walking', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'skip.md'), '# Skip\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'docs/skip.md\n', 'utf-8');
    const { report, sections } = await scanDocs(['docs'], tmpDir);
    expect(report.totalFiles).toBe(1);
    expect(sections.every((s) => s.file === 'docs/guide.md')).toBe(true);
  });
});

describe('scanDocs directory recursion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-docrec-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recurses into real subdirectories and parses nested docs', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'nested', 'deep', 'guide.md'), '# Deep\n\n## Setup\n\nNested.\n');

    const { sections, report } = await scanDocs(['docs'], tmpDir);

    expect(report.failedFiles).toEqual([]);
    expect(sections.some((s) => s.file.includes('nested'))).toBe(true);
  });

  it('returns no sections for a single-file doc_dir that is a symlink escaping the root', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-doclink-'));
    try {
      fs.writeFileSync(path.join(external, 'secret.md'), '# Secret\n\nHidden.\n');
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.symlinkSync(path.join(external, 'secret.md'), path.join(tmpDir, 'docs', 'link.md'));

      const { sections } = await scanDocs(['docs/link.md'], tmpDir);

      expect(sections).toEqual([]);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

describe('scanDocs fault-injected fs failures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-docscan-fault-'));
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a doc_dir whose stat fails after resolution as failedFiles', async () => {
    const dir = path.join(tmpDir, 'docs');
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (String(p) === dir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p);
    });
    const { report } = await scanDocs(['docs'], tmpDir);
    expect(report.failedFiles).toContain('docs');
    expect(report.skippedMissing).not.toContain('docs');
  });

  it('reports a doc_dir that vanishes before the stat check as skippedMissing', async () => {
    const dir = path.join(tmpDir, 'docs');
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (String(p) === dir) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return real(p);
    });
    const { report } = await scanDocs(['docs'], tmpDir);
    expect(report.skippedMissing).toContain('docs');
    expect(report.failedFiles).not.toContain('docs');
  });

  it('warns and continues when a subdirectory cannot be read', async () => {
    const sub = path.join(tmpDir, 'docs', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '# A\n');
    fs.writeFileSync(path.join(sub, 'b.md'), '# B\n');
    fs.chmodSync(sub, 0o000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sections } = await scanDocs(['docs'], tmpDir);
      expect(sections.map((sec) => sec.file)).toEqual(['docs/a.md']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read directory'), expect.anything());
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });

  it('visits a directory only once when several symlinks point at it', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'real'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'real', 'a.md'), '# A\n');
    fs.symlinkSync('real', path.join(tmpDir, 'docs', 'l1'), 'dir');
    fs.symlinkSync('real', path.join(tmpDir, 'docs', 'l2'), 'dir');
    const { sections } = await scanDocs(['docs'], tmpDir);
    expect(sections.map((sec) => sec.file)).toEqual(['docs/real/a.md']);
  });

  it('skips a walk entry whose realpath fails', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '# A\n');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '# B\n');
    const target = path.join(tmpDir, 'docs', 'b.md');
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p) === target) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      return real(p);
    });
    const { sections } = await scanDocs(['docs'], tmpDir);
    expect(sections.map((sec) => sec.file)).toEqual(['docs/a.md']);
  });

  it('skips a single-file doc_dir whose realpath fails during validation', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hi\n');
    const target = path.join(tmpDir, 'README.md');
    const real = fs.realpathSync;
    let calls = 0;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p) === target) {
        calls++;
        // The doc-dir probe (first call) succeeds; the per-file validation
        // realpath (second call) fails.
        if (calls === 2) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      }
      return real(p);
    });
    const { sections } = await scanDocs(['README.md'], tmpDir);
    expect(sections).toEqual([]);
  });
});
