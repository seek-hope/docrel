import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIgnored, clearIgnoreCache } from '../../src/utils/ignore.js';

describe('isIgnored', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearIgnoreCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-ignore-test-'));
  });

  it('returns false when no .docrelayignore exists', () => {
    expect(isIgnored('src/index.ts', tmpDir)).toBe(false);
    expect(isIgnored('vendor/dep.js', tmpDir)).toBe(false);
  });

  it('ignores files matching a simple pattern with *', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), '*.log\n');
    expect(isIgnored('error.log', tmpDir)).toBe(true);
    expect(isIgnored('debug.log', tmpDir)).toBe(true);
    expect(isIgnored('src/index.ts', tmpDir)).toBe(false);
  });

  it('ignores files matching ** patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), '**/*.pb.go\n');
    expect(isIgnored('src/generated/types.pb.go', tmpDir)).toBe(true);
    expect(isIgnored('types.pb.go', tmpDir)).toBe(true);
    expect(isIgnored('src/types.go', tmpDir)).toBe(false);
  });

  it('ignores directories ending in /', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'vendor/\nnode_modules/\n');
    expect(isIgnored('vendor/dep.js', tmpDir)).toBe(true);
    expect(isIgnored('node_modules/package/index.js', tmpDir)).toBe(true);
    expect(isIgnored('src/vendor.ts', tmpDir)).toBe(false);
  });

  it('supports # comments and blank lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), [
      '# Auto-generated code',
      'src/generated/',
      '',
      '# Vendored deps',
      'vendor/',
      '',
    ].join('\n'));
    expect(isIgnored('src/generated/types.ts', tmpDir)).toBe(true);
    expect(isIgnored('vendor/lib.js', tmpDir)).toBe(true);
    expect(isIgnored('src/main.ts', tmpDir)).toBe(false);
  });

  it('supports ! negation patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), [
      'src/generated/',
      '!src/generated/types.ts',
    ].join('\n'));
    expect(isIgnored('src/generated/other.ts', tmpDir)).toBe(true);
    expect(isIgnored('src/generated/types.ts', tmpDir)).toBe(false);
  });

  it('supports anchored patterns with leading /', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), '/build/\n');
    expect(isIgnored('build/output.js', tmpDir)).toBe(true);
    // Unanchored match — any directory named build
    expect(isIgnored('src/build/output.js', tmpDir)).toBe(false);
  });

  it('supports **/ pattern for matching any directory depth', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), '**/__pycache__/\n');
    expect(isIgnored('src/__pycache__/module.pyc', tmpDir)).toBe(true);
    expect(isIgnored('src/sub/deep/__pycache__/mod.pyc', tmpDir)).toBe(true);
    expect(isIgnored('src/main.py', tmpDir)).toBe(false);
  });

  it('supports test fixture patterns from the example', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), [
      '# Auto-generated code',
      'src/generated/',
      '**/*.pb.go',
      '**/__pycache__/',
      '',
      '# Vendored deps',
      'vendor/',
      'node_modules/',
      '',
      '# Test fixtures',
      '**/fixtures/',
      '**/*.test.ts',
    ].join('\n'));

    // Should be ignored
    expect(isIgnored('src/generated/types.ts', tmpDir)).toBe(true);
    expect(isIgnored('pkg/api.pb.go', tmpDir)).toBe(true);
    expect(isIgnored('deep/nested/file.pb.go', tmpDir)).toBe(true);
    expect(isIgnored('src/__pycache__/cache.pyc', tmpDir)).toBe(true);
    expect(isIgnored('vendor/lib.js', tmpDir)).toBe(true);
    expect(isIgnored('node_modules/foo/index.js', tmpDir)).toBe(true);
    expect(isIgnored('tests/fixtures/data.json', tmpDir)).toBe(true);
    expect(isIgnored('src/__tests__/utils.test.ts', tmpDir)).toBe(true);

    // Should NOT be ignored
    expect(isIgnored('src/main.ts', tmpDir)).toBe(false);
    expect(isIgnored('docs/readme.md', tmpDir)).toBe(false);
    expect(isIgnored('src/types.pb.txt', tmpDir)).toBe(false);
    expect(isIgnored('config.yaml', tmpDir)).toBe(false);
  });

  it('normalizes Windows-style backslash paths to forward slashes', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'src/generated/\n');
    // Backslash paths are normalized to forward slashes before matching
    expect(isIgnored('src\\generated\\types.ts', tmpDir)).toBe(true);
  });
});

describe('isIgnored resource guards', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearIgnoreCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-ignore-guard-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores a .docrelayignore larger than 1 MB', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), '*.log\n' + 'x'.repeat(1_048_577));

    expect(isIgnored('error.log', tmpDir)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds 1MB'));
  });

  it('warns and ignores when .docrelayignore is a directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.docrelayignore'));

    expect(isIgnored('error.log', tmpDir)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot read .docrelayignore'), expect.anything());
  });

  it('ignores a .docrelayignore with more than 10000 lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'pat\n'.repeat(10_001));

    expect(isIgnored('pat', tmpDir)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeding 10000'));
  });

  it('skips a bare negation marker without crashing', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), '!\n*.log\n');

    expect(isIgnored('error.log', tmpDir)).toBe(true);
    expect(isIgnored('src/index.ts', tmpDir)).toBe(false);
  });

  it('supports ** at the end and in the middle of a pattern', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'src/**\n**.log\n', 'utf-8');

    expect(isIgnored('src/deep/nested/file.ts', tmpDir)).toBe(true);
    expect(isIgnored('error.log', tmpDir)).toBe(true);
    expect(isIgnored('other/file.ts', tmpDir)).toBe(false);
  });

  it('matches ? as exactly one non-separator character', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'src/?.ts\n', 'utf-8');

    expect(isIgnored('src/a.ts', tmpDir)).toBe(true);
    expect(isIgnored('src/ab.ts', tmpDir)).toBe(false);
    expect(isIgnored('src/x/a.ts', tmpDir)).toBe(false);
  });
});
