import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { updateInlineDoc, extractDocstring, generateUpdatedDocstring } from '../../src/sync/inline.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('updateInlineDoc', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-inline-'));
    testFile = path.join(tmpDir, 'test.ts');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-existent file', () => {
    const result = updateInlineDoc({
      file: '/nonexistent/file.ts',
      symbolName: 'test',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '',
      newDocstring: '',
    }, tmpDir);
    expect(result).toBe(false);
  });

  it('updates the file when docstring is replaced', () => {
    const original = '/** Old doc */\nfunction foo() {}';
    fs.writeFileSync(testFile, original, 'utf-8');

    const result = updateInlineDoc({
      file: testFile,
      symbolName: 'foo',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '/** Old doc */',
      newDocstring: '/** New doc */',
    }, tmpDir);
    expect(result).toBe(true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).toContain('/** New doc */');
    expect(updated).not.toContain('/** Old doc */');
  });

  it('updates both signature and docstring', () => {
    const original = '/** Doc */\nfunction foo(x: number): void {}';
    fs.writeFileSync(testFile, original, 'utf-8');

    const result = updateInlineDoc({
      file: testFile,
      symbolName: 'foo',
      oldSignature: 'function foo(x: number): void',
      newSignature: 'function foo(x: number, y: string): void',
      oldDocstring: '/** Doc */',
      newDocstring: '/** Updated doc */',
    }, tmpDir);
    expect(result).toBe(true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).toContain('function foo(x: number, y: string): void');
    expect(updated).toContain('/** Updated doc */');
  });
});

describe('extractDocstring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-extract-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent file', () => {
    expect(extractDocstring('/nonexistent/file.ts', 'foo', tmpDir)).toBeNull();
  });

  it('extracts a JSDoc comment before a function', () => {
    const file = path.join(tmpDir, 'fn.ts');
    fs.writeFileSync(file, '/**\n * Does something.\n * @param x - input\n */\nfunction foo(x: number): void {}', 'utf-8');

    const doc = extractDocstring(file, 'foo', tmpDir);
    expect(doc).toBe('/**\n * Does something.\n * @param x - input\n */');
  });

  it('returns null when symbol is not found', () => {
    const file = path.join(tmpDir, 'fn.ts');
    fs.writeFileSync(file, 'function bar() {}', 'utf-8');

    expect(extractDocstring(file, 'foo', tmpDir)).toBeNull();
  });

  it('extracts a single-line comment before a const', () => {
    const file = path.join(tmpDir, 'const.ts');
    fs.writeFileSync(file, '// A constant\nconst foo = 42;', 'utf-8');

    const doc = extractDocstring(file, 'foo', tmpDir);
    expect(doc).toBe('// A constant');
  });
});

describe('generateUpdatedDocstring', () => {
  it('generates a JSDoc with params for a function', () => {
    const result = generateUpdatedDocstring(
      'login',
      'function',
      '',
      'function login(username: string, password: string): boolean',
    );

    expect(result).toContain('/**');
    expect(result).toContain('login — [auto-updated by DocRel]');
    expect(result).toContain('@param username — string');
    expect(result).toContain('@param password — string');
    expect(result).toContain('@returns {boolean}');
    expect(result).toContain('*/');
  });

  it('generates a JSDoc without returns for void functions', () => {
    const result = generateUpdatedDocstring(
      'greet',
      'function',
      '',
      'function greet(name: string): void',
    );

    expect(result).toContain('@param name — string');
    expect(result).toContain('@returns {void}');
  });

  it('generates a JSDoc for parameterless functions', () => {
    const result = generateUpdatedDocstring(
      'now',
      'function',
      '',
      'function now(): string',
    );

    expect(result).toContain('@returns {string}');
    expect(result).not.toContain('@param');
  });
});
