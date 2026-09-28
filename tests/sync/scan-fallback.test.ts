import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldFallbackToBuiltin, hasSourceFiles } from '../../src/sync/scan-fallback.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('scan fallback decision (shouldFallbackToBuiltin)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-fallback-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back when zero symbols, codegraph extractor, and source files exist', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'export const x = 1;\n');
    expect(shouldFallbackToBuiltin(0, 'codegraph', ['src'], tmpDir)).toBe(true);
  });

  it('does not fall back when codegraph already produced symbols', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'export const x = 1;\n');
    expect(shouldFallbackToBuiltin(42, 'codegraph', ['src'], tmpDir)).toBe(false);
  });

  it('does not fall back when already using the builtin extractor', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'export const x = 1;\n');
    expect(shouldFallbackToBuiltin(0, 'builtin', ['src'], tmpDir)).toBe(false);
  });

  it('does not fall back when code dirs are empty or missing', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty'), { recursive: true });
    expect(shouldFallbackToBuiltin(0, 'codegraph', ['empty'], tmpDir)).toBe(false);
    expect(shouldFallbackToBuiltin(0, 'codegraph', ['nonexistent'], tmpDir)).toBe(false);
  });

  it('does not fall back when code dirs contain no source files', () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data', 'notes.txt'), 'plain text\n');
    expect(shouldFallbackToBuiltin(0, 'codegraph', ['data'], tmpDir)).toBe(false);
  });

  it('hasSourceFiles skips node_modules and hidden dirs', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'node_modules', 'pkg', 'index.ts'), 'export const x = 1;\n');
    expect(hasSourceFiles(['src'], tmpDir)).toBe(false);
    // But an actual top-level source file IS found.
    fs.writeFileSync(path.join(tmpDir, 'src', 'real.ts'), 'export const y = 2;\n');
    expect(hasSourceFiles(['src'], tmpDir)).toBe(true);
  });

  it('skips code_dirs that are files, not directories', () => {
    fs.writeFileSync(path.join(tmpDir, 'not-a-dir.ts'), 'export const z = 3;\n');
    expect(hasSourceFiles(['not-a-dir.ts'], tmpDir)).toBe(false);
  });

  it('finds source files inside nested subdirectories', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'nested', 'deep', 'x.ts'), 'export const x = 1;\n');
    expect(hasSourceFiles(['src'], tmpDir)).toBe(true);
  });

  it('dedupes directories reached through multiple symlinks', () => {
    const real = path.join(tmpDir, 'src', 'real');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'x.ts'), 'export const x = 1;\n');
    fs.symlinkSync('real', path.join(tmpDir, 'src', 'l1'), 'dir');
    fs.symlinkSync('real', path.join(tmpDir, 'src', 'l2'), 'dir');
    // l1/l2 resolve to the already-seen real dir — the scan must not
    // descend twice (nor hang), and still finds the source file.
    expect(shouldFallbackToBuiltin(0, 'codegraph', ['src'], tmpDir)).toBe(true);
  });

  it('tolerates symlink loops without hanging', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, 'src'), path.join(tmpDir, 'src', 'sub', 'loop'), 'dir');
    // No source files anywhere — the loop must not cause infinite traversal.
    expect(hasSourceFiles(['src'], tmpDir)).toBe(false);
  });
});
