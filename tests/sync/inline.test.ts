import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { updateInlineDoc, extractDocstring, generateUpdatedDocstring } from '../../src/sync/inline.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('updateInlineDoc', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-inline-'));
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

  it('locates signatures in files that begin with a line comment (repo header convention)', () => {
    // Regression: the occurrence-count haystack was built by calling the
    // per-line stripCommentsAndStrings on WHOLE-FILE content. Its // branch
    // stops at the first line comment, so a file starting with a line
    // comment stripped to an empty string and every inline sync failed
    // with "signature missing from source".
    const original = [
      '// src/widget.ts — module header comment',
      '/** Renders the widget. */',
      'export function renderWidget(size: number): void {',
      '  void size;',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(testFile, original, 'utf-8');

    const result = updateInlineDoc({
      file: testFile,
      symbolName: 'renderWidget',
      oldSignature: 'export function renderWidget(size: number): void {',
      newSignature: 'export function renderWidget(size: number, dpi: number): void {',
      oldDocstring: '/** Renders the widget. */',
      newDocstring: '/** Renders the widget at a DPI. */',
    }, tmpDir);
    expect(result).toBe(true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).toContain('dpi: number');
    expect(updated).toContain('/** Renders the widget at a DPI. */');
  });

  it('locates const signatures containing string literals after a line-comment header', () => {
    // Dogfood finding (NON_SYMBOL_KINDS): a const whose signature is mostly
    // a string literal, in a file with a leading // header, could not be
    // located in the stripped haystack at all.
    const original = [
      '// src/kinds.ts — symbol kind constants',
      '/** Index node kinds excluded from enumeration. */',
      'const NON_SYMBOL_KINDS = "\'import\',\'file\',\'property\'";',
      'export { NON_SYMBOL_KINDS };',
      '',
    ].join('\n');
    fs.writeFileSync(testFile, original, 'utf-8');

    const result = updateInlineDoc({
      file: testFile,
      symbolName: 'NON_SYMBOL_KINDS',
      oldSignature: 'const NON_SYMBOL_KINDS = "\'import\',\'file\',\'property\'";',
      newSignature: 'const NON_SYMBOL_KINDS = "\'import\',\'file\',\'property\',\'type_param\'";',
      oldDocstring: '/** Index node kinds excluded from enumeration. */',
      newDocstring: '/** Index node kinds excluded from enumeration (updated). */',
    }, tmpDir);
    expect(result).toBe(true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).toContain("'type_param'");
    expect(updated).toContain('(updated)');
  });
});

describe('extractDocstring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-extract-'));
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

  it('extracts a JSDoc comment before a multi-line class method definition', () => {
    // The method opener spans multiple lines (`login(\n  user: string\n)`),
    // which no single-line alternative in the symbol regex matches.
    const file = path.join(tmpDir, 'm.ts');
    fs.writeFileSync(
      file,
      'class Auth {\n  /**\n   * Logs in.\n   */\n  login(\n    user: string\n  ): boolean {\n    return true;\n  }\n}\n',
      'utf-8',
    );

    const doc = extractDocstring(file, 'login', tmpDir, 4);
    expect(doc).toBe('  /**\n   * Logs in.\n   */');
  });

  it('does not match a same-named call prefixed by an expression', () => {
    // `return login(` and `const x = login(` must not be treated as
    // definitions — the opener pattern is anchored to the line start.
    const file = path.join(tmpDir, 'call.ts');
    fs.writeFileSync(
      file,
      '/** Real docs */\nfunction caller() {\n  return login(\n    user\n  );\n}\n',
      'utf-8',
    );

    expect(extractDocstring(file, 'login', tmpDir)).toBeNull();
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-multi-'));
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-upd-multi-'));
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
    expect(result).toContain('login — [auto-updated by DocRelay]');
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

// ── updateInlineDoc guard paths ────────────────────────────────────────────

describe('updateInlineDoc guard paths', () => {
  let tmpDir: string;
  let testFile: string;

  const baseInput = {
    symbolName: 'foo',
    oldSignature: '',
    newSignature: '',
    oldDocstring: '',
    newDocstring: '',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-inline-guard-'));
    testFile = path.join(tmpDir, 'test.ts');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses to update a directory', () => {
    const dir = path.join(tmpDir, 'adir');
    fs.mkdirSync(dir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({ ...baseInput, file: dir }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a regular file'), expect.anything());
  });

  it('refuses files exceeding the 10MB size limit', () => {
    fs.writeFileSync(testFile, Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({ ...baseInput, file: testFile }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('exceeds size limit'), expect.anything(), expect.anything(),
    );
  });

  it('returns false when the file cannot be read', () => {
    fs.writeFileSync(testFile, 'function foo() {}', 'utf-8');
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({ ...baseInput, file: testFile }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read file'), expect.anything(), expect.anything(),
    );
  });

  it('skips non-JSDoc updates when docstrings are empty', () => {
    const pyFile = path.join(tmpDir, 'mod.py');
    fs.writeFileSync(pyFile, 'def foo():\n    """Doc."""\n    pass\n', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({ ...baseInput, file: pyFile }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped docstring — old or new docstring is empty'),
    );
  });

  it('refuses python updates when the new docstring would not be unique', () => {
    const pyFile = path.join(tmpDir, 'mod.py');
    const original = [
      'def foo():',
      '    """Old."""',
      '    pass',
      '',
      '"""New."""',
      '',
    ].join('\n');
    fs.writeFileSync(pyFile, original, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: pyFile,
      oldDocstring: '"""Old."""',
      newDocstring: '"""New."""',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('post-validation failed — new docstring count != 1'),
    );
    expect(fs.readFileSync(pyFile, 'utf-8')).toBe(original);
  });

  it('skips replacement when the old signature exceeds the search limit', () => {
    fs.writeFileSync(testFile, '/** Doc */\nfunction foo() {}', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: 'x'.repeat(10_001),
      newSignature: 'y',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('old signature exceeds 10000 chars'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped docstring — old or new docstring is empty'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('had nothing to replace'));
  });

  it('skips replacement when the old docstring exceeds the search limit', () => {
    fs.writeFileSync(testFile, '/** Doc */\nfunction foo() {}', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldDocstring: 'x'.repeat(10_001),
      newDocstring: 'y',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('old docstring exceeds 10000 chars'));
  });

  it('logs a diagnostic when stripped and full signature counts diverge', () => {
    const content = [
      '/**',
      ' * Calls function foo(x: number): void internally.',
      ' * Also see function foo(x: number): void for details.',
      ' */',
      'function bar() {}',
    ].join('\n');
    fs.writeFileSync(testFile, content, 'utf-8');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: 'function foo(x: number): void',
      newSignature: 'function foo(x: number, y: string): void',
    }, tmpDir);
    expect(result).toBe(false);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('occurrence count differs'));
  });

  it('skips signature replacement when the full-content count disagrees', () => {
    const content = [
      'function foo(x: number): void {}',
      '// Old sig: function foo(x: number): void',
    ].join('\n');
    fs.writeFileSync(testFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: 'function foo(x: number): void',
      newSignature: 'function foo(x: string): void',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('count mismatch (non-comment: 1, full: 2)'),
    );
    expect(fs.readFileSync(testFile, 'utf-8')).toBe(content);
  });

  it('refuses partial updates when the signature is ambiguous but the docstring matched', () => {
    const content = [
      '/** Doc */',
      'function dup(x: number): void {}',
      'function dup(x: number): void {}',
    ].join('\n');
    fs.writeFileSync(testFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile, symbolName: 'dup',
      oldSignature: 'function dup(x: number): void',
      newSignature: 'function dup(x: number, y: string): void',
      oldDocstring: '/** Doc */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('old signature count is 2 (expected 1)'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signature ambiguous, refusing partial update'));
    expect(fs.readFileSync(testFile, 'utf-8')).toBe(content);
  });

  it('skips the docstring when it appears more than once', () => {
    const content = '/** Doc */\nfunction foo() {}\n/** Doc */\nfunction bar() {}';
    fs.writeFileSync(testFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldDocstring: '/** Doc */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('old docstring count is 2 (expected 1)'));
  });

  it('refuses partial updates when the signature is missing from the source', () => {
    const content = '/** Doc */\nfunction foo() {}';
    fs.writeFileSync(testFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: 'function missing(): void',
      newSignature: 'function missing(a: string): void',
      oldDocstring: '/** Doc */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('signature missing from source, refusing partial update'),
    );
    expect(fs.readFileSync(testFile, 'utf-8')).toBe(content);
  });

  it('updates a signature containing string and template literal defaults', () => {
    // Regression: signatures with string/template defaults were counted
    // verbatim against comment+string-stripped content, so they never matched
    // and every inline sync failed with "signature missing from source".
    const sig = 'function foo(a: string = "x\\")y", b: string = `p${q}r`): void';
    const content = `/** Doc */\n${sig} {}`;
    fs.writeFileSync(testFile, content, 'utf-8');
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: sig,
      newSignature: 'function foo(a: string, b: string): void',
      oldDocstring: '/** Doc */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(true);
    const updated = fs.readFileSync(testFile, 'utf-8');
    expect(updated).toContain('function foo(a: string, b: string): void');
    expect(updated).toContain('/** New */');
  });

  it('still skips replacement when the string-stripped signature is ambiguous', () => {
    // Two definitions whose code shape collides once string literals are
    // stripped must stay ambiguous — better to skip than to mis-replace.
    const content =
      '/** Doc */\nfunction foo(a: string = "x"): void {}\nfunction foo(a: string = "y"): void {}';
    fs.writeFileSync(testFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: 'function foo(a: string = "x"): void',
      newSignature: 'function foo(a: string): void',
      oldDocstring: '/** Doc */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('old signature count is 2 (expected 1)'),
    );
    expect(fs.readFileSync(testFile, 'utf-8')).toBe(content);
  });

  it('fails post-validation when the new signature is stripped as a comment', () => {
    const content = 'function foo(x: number): void {}';
    fs.writeFileSync(testFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: 'function foo(x: number): void',
      newSignature: 'function foo(x: number /* weasel */): void',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('post-validation failed — new signature count != 1'),
    );
    expect(fs.readFileSync(testFile, 'utf-8')).toBe(content);
  });

  it('fails post-validation when the new docstring appears more than once', () => {
    const content = '/** Old */\nfunction foo() {}\n/** New */\nfunction bar() {}';
    fs.writeFileSync(testFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldDocstring: '/** Old */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('post-validation failed — new docstring count != 1'),
    );
    expect(fs.readFileSync(testFile, 'utf-8')).toBe(content);
  });

  it('returns false when the temp directory cannot be created', () => {
    fs.writeFileSync(testFile, '/** Old */\nfunction foo() {}', 'utf-8');
    // A regular file at .docrelay makes the recursive tmp mkdir fail.
    fs.writeFileSync(path.join(tmpDir, '.docrelay'), 'not a directory', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldDocstring: '/** Old */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not create temp directory'), expect.anything(),
    );
  });

  it('returns false when the atomic write fails', () => {
    fs.writeFileSync(testFile, '/** Old */\nfunction foo() {}', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Installed after setup — only the temp-file write inside updateInlineDoc
    // goes through the throwing mock; the missing-temp unlink is best-effort.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldDocstring: '/** Old */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('atomic write failed'), expect.anything());
  });

  it('aborts occurrence counting at the 100k match limit', () => {
    fs.writeFileSync(testFile, 'a'.repeat(100_001), 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldSignature: 'a',
      newSignature: 'b',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('countOccurrences aborted'));
  });

  it('handles string literals while counting docstring occurrences', () => {
    const content = [
      '/** Doc */',
      'function foo() {',
      '  const d = "has /* no */ \\" escaped";',
      "  const s = 'it\\'s fine';",
      '  const t = `tpl ${nest(`inner`)} end`;',
      '  const u = `esc \\` tick`;',
      '  return d;',
      '}',
    ].join('\n');
    fs.writeFileSync(testFile, content, 'utf-8');
    const result = updateInlineDoc({
      ...baseInput, file: testFile,
      oldDocstring: '/** Doc */',
      newDocstring: '/** New */',
    }, tmpDir);
    expect(result).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toContain('/** New */');
  });
});

// ── extractDocstring guard paths ───────────────────────────────────────────

describe('extractDocstring guard paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-extract-guard-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for an empty project root', () => {
    expect(extractDocstring('file.ts', 'foo', '')).toBeNull();
  });

  it('returns null for a directory target', () => {
    const dir = path.join(tmpDir, 'adir');
    fs.mkdirSync(dir);
    expect(extractDocstring(dir, 'foo', tmpDir)).toBeNull();
  });

  it('warns and returns null on non-ENOENT read failures', () => {
    const file = path.join(tmpDir, 'fn.ts');
    fs.writeFileSync(file, 'function foo() {}', 'utf-8');
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractDocstring(file, 'foo', tmpDir)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('extractDocstring failed'), expect.anything());
  });

  it('returns null for JSDoc files exceeding 100k lines', () => {
    const file = path.join(tmpDir, 'big.ts');
    fs.writeFileSync(file, '/** d */\nfunction foo() {}\n' + 'x\n'.repeat(100_001), 'utf-8');
    expect(extractDocstring(file, 'foo', tmpDir)).toBeNull();
  });

  it('handles strings ending in a backslash while stripping block comments', () => {
    const doubleFile = path.join(tmpDir, 'double.ts');
    fs.writeFileSync(doubleFile, 'const s = "ab\\', 'utf-8');
    expect(extractDocstring(doubleFile, 'foo', tmpDir)).toBeNull();

    const singleFile = path.join(tmpDir, 'single.ts');
    fs.writeFileSync(singleFile, "const s = 'ab\\", 'utf-8');
    expect(extractDocstring(singleFile, 'foo', tmpDir)).toBeNull();

    const tplFile = path.join(tmpDir, 'tpl.ts');
    fs.writeFileSync(tplFile, 'const t = `ab\\', 'utf-8');
    expect(extractDocstring(tplFile, 'foo', tmpDir)).toBeNull();
  });
});

// ── python docstring extraction edge cases ─────────────────────────────────

describe('python docstring extraction edge cases', () => {
  let tmpDir: string;
  let pyFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-py-edge-'));
    pyFile = path.join(tmpDir, 'mod.py');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the symbol is not defined', () => {
    fs.writeFileSync(pyFile, 'def bar():\n    """Doc."""\n', 'utf-8');
    expect(extractDocstring(pyFile, 'foo', tmpDir)).toBeNull();
  });

  it('skips inline comments after the def colon', () => {
    fs.writeFileSync(pyFile, 'def foo():  # inline note\n    """Real doc."""\n', 'utf-8');
    expect(extractDocstring(pyFile, 'foo', tmpDir)).toBe('"""Real doc."""');
  });

  it('returns null for a def at end-of-file with whitespace only', () => {
    fs.writeFileSync(pyFile, 'def foo():\n    ', 'utf-8');
    expect(extractDocstring(pyFile, 'foo', tmpDir)).toBeNull();
  });

  it('skips blank and comment lines before the docstring', () => {
    fs.writeFileSync(pyFile, 'def foo():\n\n    # a comment\n    """doc"""\n', 'utf-8');
    expect(extractDocstring(pyFile, 'foo', tmpDir)).toBe('"""doc"""');
  });

  it('returns null for an unterminated docstring', () => {
    fs.writeFileSync(pyFile, 'def foo():\n    """unterminated\n', 'utf-8');
    expect(extractDocstring(pyFile, 'foo', tmpDir)).toBeNull();
  });

  it('returns null when the body ends after comments', () => {
    fs.writeFileSync(pyFile, 'def foo():\n    # only a comment\n', 'utf-8');
    expect(extractDocstring(pyFile, 'foo', tmpDir)).toBeNull();
  });

  it('fails updates when the def header has no colon', () => {
    const content = 'def foo(x)  # missing colon\n    """doc"""\n';
    fs.writeFileSync(pyFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      file: pyFile,
      symbolName: 'foo',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '"""doc"""',
      newDocstring: '"""new"""',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not replace python docstring'),
    );
    expect(fs.readFileSync(pyFile, 'utf-8')).toBe(content);
  });
});

// ── go and rust docstring extraction edge cases ────────────────────────────

describe('go and rust docstring extraction edge cases', () => {
  let tmpDir: string;
  let goFile: string;
  let rsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-gors-edge-'));
    goFile = path.join(tmpDir, 'mod.go');
    rsFile = path.join(tmpDir, 'mod.rs');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the go symbol is not defined', () => {
    fs.writeFileSync(goFile, 'package main\n\nfunc Bar() {}\n', 'utf-8');
    expect(extractDocstring(goFile, 'Foo', tmpDir)).toBeNull();
  });

  it('returns null for go files exceeding 100k lines', () => {
    fs.writeFileSync(
      goFile,
      'package main\n\n// Doc.\nfunc Foo() {}\n' + '\n'.repeat(100_001),
      'utf-8',
    );
    expect(extractDocstring(goFile, 'Foo', tmpDir)).toBeNull();
  });

  it('stops go comment collection at a blank line above the doc block', () => {
    const content = 'package main\n\n// Doc.\n\n// Real doc.\nfunc Foo() {}\n';
    fs.writeFileSync(goFile, content, 'utf-8');
    expect(extractDocstring(goFile, 'Foo', tmpDir)).toBe('// Real doc.');
  });

  it('returns null for a go func without a doc comment', () => {
    fs.writeFileSync(goFile, 'package main\n\nfunc Foo() {}\n', 'utf-8');
    expect(extractDocstring(goFile, 'Foo', tmpDir)).toBeNull();
  });

  it('refuses go updates when the old comment mismatches', () => {
    const content = '// Actual.\nfunc Foo() {}\n';
    fs.writeFileSync(goFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      file: goFile,
      symbolName: 'Foo',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '// Wrong.',
      newDocstring: '// New.',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not replace go docstring'),
    );
    expect(fs.readFileSync(goFile, 'utf-8')).toBe(content);
  });

  it('returns null when the rust symbol is not defined', () => {
    fs.writeFileSync(rsFile, 'fn bar() {}\n', 'utf-8');
    expect(extractDocstring(rsFile, 'foo', tmpDir)).toBeNull();
  });

  it('returns null for rust files exceeding 100k lines', () => {
    fs.writeFileSync(rsFile, '/// Doc.\nfn foo() {}\n' + '\n'.repeat(100_001), 'utf-8');
    expect(extractDocstring(rsFile, 'foo', tmpDir)).toBeNull();
  });

  it('stops rust comment collection at a blank line above the doc block', () => {
    const content = 'use std::io;\n\n/// Doc.\nfn foo() {}\n';
    fs.writeFileSync(rsFile, content, 'utf-8');
    expect(extractDocstring(rsFile, 'foo', tmpDir)).toBe('/// Doc.');
  });

  it('stops rust comment collection at code lines', () => {
    const content = 'const X: i32 = 1;\n/// Doc.\nfn foo() {}\n';
    fs.writeFileSync(rsFile, content, 'utf-8');
    expect(extractDocstring(rsFile, 'foo', tmpDir)).toBe('/// Doc.');
  });

  it('returns null for a rust fn without a doc comment', () => {
    fs.writeFileSync(rsFile, 'fn foo() {}\n', 'utf-8');
    expect(extractDocstring(rsFile, 'foo', tmpDir)).toBeNull();
  });

  it('refuses rust updates when the old comment mismatches', () => {
    const content = '/// Actual.\nfn foo() {}\n';
    fs.writeFileSync(rsFile, content, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = updateInlineDoc({
      file: rsFile,
      symbolName: 'foo',
      oldSignature: '',
      newSignature: '',
      oldDocstring: '/// Wrong.',
      newDocstring: '/// New.',
    }, tmpDir);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not replace rust docstring'),
    );
    expect(fs.readFileSync(rsFile, 'utf-8')).toBe(content);
  });
});
