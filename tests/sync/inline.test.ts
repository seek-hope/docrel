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

describe('multi-language extractDocstring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-multi-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Python ---

  it('extracts a Python triple-quoted docstring after a function', () => {
    const file = path.join(tmpDir, 'mod.py');
    fs.writeFileSync(file, [
      'def greet(name: str) -> str:',
      '    """Say hello to someone."""',
      '    return f"Hello, {name}"',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'greet', tmpDir);
    expect(doc).toBe('"""Say hello to someone."""');
  });

  it('extracts a Python docstring after a class definition', () => {
    const file = path.join(tmpDir, 'mod.py');
    fs.writeFileSync(file, [
      'class User:',
      '    """Represents a user of the system."""',
      '    def __init__(self, name: str):',
      '        self.name = name',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'User', tmpDir);
    expect(doc).toBe('"""Represents a user of the system."""');
  });

  it('extracts a Python docstring with single quotes', () => {
    const file = path.join(tmpDir, 'mod.py');
    fs.writeFileSync(file, [
      'def foo() -> None:',
      "    '''Does a thing.'''",
      '    pass',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'foo', tmpDir);
    expect(doc).toBe("'''Does a thing.'''");
  });

  it('returns null for Python function without docstring', () => {
    const file = path.join(tmpDir, 'mod.py');
    fs.writeFileSync(file, [
      'def bar(x: int) -> int:',
      '    return x * 2',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'bar', tmpDir);
    expect(doc).toBeNull();
  });

  // --- Go ---

  it('extracts Go // doc comment before a function', () => {
    const file = path.join(tmpDir, 'mod.go');
    fs.writeFileSync(file, [
      'package main',
      '',
      '// Greet says hello to the given name.',
      'func Greet(name string) string {',
      '\treturn "Hello, " + name',
      '}',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'Greet', tmpDir);
    expect(doc).toBe('// Greet says hello to the given name.');
  });

  it('extracts a multi-line Go doc comment', () => {
    const file = path.join(tmpDir, 'mod.go');
    fs.writeFileSync(file, [
      'package main',
      '',
      '// User represents a system user.',
      '// It holds authentication info.',
      'type User struct {',
      '\tName string',
      '}',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'User', tmpDir);
    expect(doc).toBe('// User represents a system user.\n// It holds authentication info.');
  });

  // --- Rust ---

  it('extracts Rust /// doc comment before a function', () => {
    const file = path.join(tmpDir, 'mod.rs');
    fs.writeFileSync(file, [
      '/// Adds two numbers together.',
      '///',
      '/// # Examples',
      '/// ```',
      '/// let r = add(2, 3);',
      '/// assert_eq!(r, 5);',
      '/// ```',
      'pub fn add(a: i32, b: i32) -> i32 {',
      '    a + b',
      '}',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'add', tmpDir);
    expect(doc).toContain('/// Adds two numbers together.');
    expect(doc).toContain('/// # Examples');
    expect(doc).toContain('/// let r = add');
  });

  it('extracts Rust /// doc comment before a struct, skipping attributes', () => {
    const file = path.join(tmpDir, 'mod.rs');
    fs.writeFileSync(file, [
      '/// Configuration for the server.',
      '#[derive(Debug, Clone)]',
      'pub struct Config {',
      '    pub port: u16,',
      '}',
      '',
    ].join('\n'), 'utf-8');

    const doc = extractDocstring(file, 'Config', tmpDir);
    expect(doc).toBe('/// Configuration for the server.');
  });
});

describe('multi-language updateInlineDoc', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-upd-multi-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Python ---

  it('updates a Python docstring', () => {
    const file = path.join(tmpDir, 'mod.py');
    const original = [
      'def greet(name: str) -> str:',
      '    """Old greeting."""',
      '    return f"Hello, {name}"',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf-8');

    const result = updateInlineDoc({
      file,
      symbolName: 'greet',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '"""Old greeting."""',
      newDocstring: '"""New greeting."""',
    }, tmpDir);

    expect(result).toBe(true);
    const updated = fs.readFileSync(file, 'utf-8');
    expect(updated).toContain('"""New greeting."""');
    expect(updated).not.toContain('"""Old greeting."""');
  });

  it('updates a Python docstring preserving indentation', () => {
    const file = path.join(tmpDir, 'mod.py');
    const original = [
      'class App:',
      '    """Version 1.0"""',
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf-8');

    const result = updateInlineDoc({
      file,
      symbolName: 'App',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '"""Version 1.0"""',
      newDocstring: '"""Version 2.0 — major refactor"""',
    }, tmpDir);

    expect(result).toBe(true);
    const updated = fs.readFileSync(file, 'utf-8');
    expect(updated).toContain('"""Version 2.0 — major refactor"""');
  });

  it('refuses Python docstring update when old docstring mismatches', () => {
    const file = path.join(tmpDir, 'mod.py');
    const original = [
      'def foo() -> None:',
      '    """Actual doc."""',
      '    pass',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf-8');

    const result = updateInlineDoc({
      file,
      symbolName: 'foo',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '"""Wrong doc."""',
      newDocstring: '"""New doc."""',
    }, tmpDir);

    expect(result).toBe(false);
    const unchanged = fs.readFileSync(file, 'utf-8');
    expect(unchanged).toBe(original);
  });

  // --- Go ---

  it('updates a Go doc comment', () => {
    const file = path.join(tmpDir, 'mod.go');
    const original = [
      'package main',
      '',
      '// Old comment.',
      'func Greet(name string) string {',
      '\treturn "Hello"',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf-8');

    const result = updateInlineDoc({
      file,
      symbolName: 'Greet',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '// Old comment.',
      newDocstring: '// New comment.',
    }, tmpDir);

    expect(result).toBe(true);
    const updated = fs.readFileSync(file, 'utf-8');
    expect(updated).toContain('// New comment.');
    expect(updated).not.toContain('// Old comment.');
  });

  // --- Rust ---

  it('updates a Rust doc comment', () => {
    const file = path.join(tmpDir, 'mod.rs');
    const original = [
      '/// Old doc.',
      'pub fn add(a: i32, b: i32) -> i32 {',
      '    a + b',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf-8');

    const result = updateInlineDoc({
      file,
      symbolName: 'add',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '/// Old doc.',
      newDocstring: '/// New doc.',
    }, tmpDir);

    expect(result).toBe(true);
    const updated = fs.readFileSync(file, 'utf-8');
    expect(updated).toContain('/// New doc.');
    expect(updated).not.toContain('/// Old doc.');
  });

  it('updates a multi-line Rust doc comment', () => {
    const file = path.join(tmpDir, 'mod.rs');
    const original = [
      '/// First line.',
      '/// Second line.',
      'pub fn foo() {}',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf-8');

    const oldDoc = '/// First line.\n/// Second line.';
    const newDoc = '/// Updated first.\n/// Updated second.';
    const result = updateInlineDoc({
      file,
      symbolName: 'foo',
      oldSignature: '',
      newSignature: '',
      oldDocstring: oldDoc,
      newDocstring: newDoc,
    }, tmpDir);

    expect(result).toBe(true);
    const updated = fs.readFileSync(file, 'utf-8');
    expect(updated).toContain('/// Updated first.');
    expect(updated).toContain('/// Updated second.');
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
