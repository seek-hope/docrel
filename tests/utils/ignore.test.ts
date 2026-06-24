import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIgnored, clearIgnoreCache } from '../../src/utils/ignore.js';

describe('isIgnored', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearIgnoreCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsync-ignore-test-'));
  });

  it('returns false when no .docsyncignore exists', () => {
    expect(isIgnored('src/index.ts', tmpDir)).toBe(false);
    expect(isIgnored('vendor/dep.js', tmpDir)).toBe(false);
  });

  it('ignores files matching a simple pattern with *', () => {
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), '*.log\n');
    expect(isIgnored('error.log', tmpDir)).toBe(true);
    expect(isIgnored('debug.log', tmpDir)).toBe(true);
    expect(isIgnored('src/index.ts', tmpDir)).toBe(false);
  });

  it('ignores files matching ** patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), '**/*.pb.go\n');
    expect(isIgnored('src/generated/types.pb.go', tmpDir)).toBe(true);
    expect(isIgnored('types.pb.go', tmpDir)).toBe(true);
    expect(isIgnored('src/types.go', tmpDir)).toBe(false);
  });

  it('ignores directories ending in /', () => {
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), 'vendor/\nnode_modules/\n');
    expect(isIgnored('vendor/dep.js', tmpDir)).toBe(true);
    expect(isIgnored('node_modules/package/index.js', tmpDir)).toBe(true);
    expect(isIgnored('src/vendor.ts', tmpDir)).toBe(false);
  });

  it('supports # comments and blank lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), [
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
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), [
      'src/generated/',
      '!src/generated/types.ts',
    ].join('\n'));
    expect(isIgnored('src/generated/other.ts', tmpDir)).toBe(true);
    expect(isIgnored('src/generated/types.ts', tmpDir)).toBe(false);
  });

  it('supports anchored patterns with leading /', () => {
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), '/build/\n');
    expect(isIgnored('build/output.js', tmpDir)).toBe(true);
    // Unanchored match — any directory named build
    expect(isIgnored('src/build/output.js', tmpDir)).toBe(false);
  });

  it('supports **/ pattern for matching any directory depth', () => {
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), '**/__pycache__/\n');
    expect(isIgnored('src/__pycache__/module.pyc', tmpDir)).toBe(true);
    expect(isIgnored('src/sub/deep/__pycache__/mod.pyc', tmpDir)).toBe(true);
    expect(isIgnored('src/main.py', tmpDir)).toBe(false);
  });

  it('supports test fixture patterns from the example', () => {
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), [
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
    fs.writeFileSync(path.join(tmpDir, '.docsyncignore'), 'src/generated/\n');
    // Backslash paths are normalized to forward slashes before matching
    expect(isIgnored('src\\generated\\types.ts', tmpDir)).toBe(true);
  });
});
