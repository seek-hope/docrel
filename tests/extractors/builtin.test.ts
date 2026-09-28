import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BuiltinExtractor, extractLeadingDocstring } from '../../src/extractors/builtin.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// EACCES-based tests are meaningless when running as root (root bypasses
// filesystem permission checks entirely).
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('BuiltinExtractor filesystem guards', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const extractor = new BuiltinExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-builtin-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips code dirs outside the project root', async () => {
    expect(await extractor.extract('../outside', tmpDir)).toEqual([]);
  });

  it('returns empty for a missing code dir', async () => {
    expect(await extractor.extract('no-such-dir', tmpDir)).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects a symlinked code dir escaping the root', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-ext-'));
    try {
      fs.writeFileSync(path.join(external, 'evil.ts'), 'export class Evil {}\n');
      fs.symlinkSync(external, path.join(tmpDir, 'src-link'), 'dir');

      expect(await extractor.extract('src-link', tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('returns empty when the code dir is a plain file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'not-a-dir.ts'), 'export class X {}\n');

    expect(await extractor.extract('not-a-dir.ts', tmpDir)).toEqual([]);
  });

  it('recurses into subdirectories but skips hidden and vendor dirs', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'sub', 'ok.ts'), 'export class Found {}\n');
    fs.mkdirSync(path.join(tmpDir, 'src', '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', '.hidden', 'no.ts'), 'export class Hidden {}\n');
    fs.mkdirSync(path.join(tmpDir, 'src', 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'node_modules', 'pkg', 'no.ts'), 'export class Vendored {}\n');

    const symbols = await extractor.extract('src', tmpDir);

    expect(symbols.map((s) => s.name)).toEqual(['Found']);
  });

  it('skips files larger than 10 MB', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'big.ts'),
      'export class Big {}\n' + '//'.repeat(6 * 1024 * 1024),
    );

    expect(await extractor.extract('src', tmpDir)).toEqual([]);
  });

  it('skips files with more than 100k lines', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'lines.ts'),
      'export class Lines {}\n' + '// filler\n'.repeat(100_001),
    );

    expect(await extractor.extract('src', tmpDir)).toEqual([]);
  });

  it('returns empty for supported extensions that have no rules (.pyi)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'stub.pyi'), 'def foo() -> None: ...\n');

    expect(await extractor.extract('src', tmpDir)).toEqual([]);
  });

  it('honors the incremental since cutoff with a 1s tolerance', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'export class Fresh {}\n');

    // File was just written — mtime is within the tolerance of "now".
    expect(await extractor.extract('src', tmpDir, Date.now())).toEqual([]);
    // A zero cutoff includes everything.
    expect((await extractor.extract('src', tmpDir, 0)).map((s) => s.name)).toEqual(['Fresh']);
  });

  it.skipIf(isRoot)('warns and skips unreadable source files', async () => {
    const file = path.join(tmpDir, 'src', 'locked.ts');
    fs.writeFileSync(file, 'export class Locked {}\n');
    fs.chmodSync(file, 0o000);

    try {
      expect(await extractor.extract('src', tmpDir)).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot read source file'), expect.anything());
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});

describe('BuiltinExtractor docstring extraction', () => {
  let tmpDir: string;
  const extractor = new BuiltinExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-builtin-doc-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures a single-line JSDoc block', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), '/** Single-line docs. */\nexport class Foo {}\n');

    const symbols = await extractor.extract('src', tmpDir);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].docstring).toBe('/** Single-line docs. */');
  });

  it('captures python docstrings after comment lines, including multi-line', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'mod.py'),
      'def foo():\n    # leading comment\n    """First line.\n\n    More detail.\n    """\n    return 1\n',
    );

    const symbols = await extractor.extract('src', tmpDir);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].docstring).toContain('First line.');
    expect(symbols[0].docstring).toContain('More detail.');
  });
});

describe('extractLeadingDocstring edge cases', () => {
  it('returns undefined for unsupported languages', () => {
    expect(extractLeadingDocstring(['fn main() {}'], 0, 'rust')).toBeUndefined();
  });

  it('returns undefined when a python def has no docstring', () => {
    expect(extractLeadingDocstring(['def foo():', '    return 1'], 0, 'python')).toBeUndefined();
    expect(extractLeadingDocstring(['def foo():'], 0, 'python')).toBeUndefined();
  });

  it('captures a single-line python docstring', () => {
    expect(extractLeadingDocstring(['def foo():', '    """One-liner."""', '    return 1'], 0, 'python'))
      .toBe('"""One-liner."""');
  });
});

describe('BuiltinExtractor fault-injected fs failures', () => {
  let tmpDir: string;
  const extractor = new BuiltinExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-builtin-fault-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns when the code dir cannot be resolved (non-ENOENT)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p) === path.join(tmpDir, 'src')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p);
    });
    expect(await extractor.extract('src', tmpDir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot resolve code directory'), expect.anything());
  });

  it('warns when the code dir vanishes before the stat check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (String(p) === path.join(tmpDir, 'src')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return real(p);
    });
    expect(await extractor.extract('src', tmpDir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code directory not found'));
  });

  it('warns when the code dir cannot be stat-ed for other reasons', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (String(p) === path.join(tmpDir, 'src')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p);
    });
    expect(await extractor.extract('src', tmpDir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot access code directory'));
  });

  it('warns and continues when a subdirectory cannot be read', async () => {
    const sub = path.join(tmpDir, 'src', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'b.ts'), 'export function beta(): number {\n  return 2;\n}\n');
    fs.chmodSync(sub, 0o000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const symbols = await extractor.extract('src', tmpDir);
      expect(symbols.map((s) => s.name)).toEqual(['alpha']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read directory'), expect.anything());
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });

  it('skips walk entries whose realpath fails', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'sub'), { recursive: true });
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p) === path.join(tmpDir, 'src', 'sub')) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      return real(p);
    });
    const symbols = await extractor.extract('src', tmpDir);
    expect(symbols.map((s) => s.name)).toEqual(['alpha']);
  });

  it('visits a directory only once when several symlinks point at it', async () => {
    const real = path.join(tmpDir, 'src', 'real');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'x.ts'), 'export function shared(): number {\n  return 3;\n}\n');
    fs.symlinkSync('real', path.join(tmpDir, 'src', 'l1'), 'dir');
    fs.symlinkSync('real', path.join(tmpDir, 'src', 'l2'), 'dir');
    const symbols = await extractor.extract('src', tmpDir);
    expect(symbols.filter((s) => s.name === 'shared')).toHaveLength(1);
  });

  it('rejects a source file that resolves outside the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-builtin-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.ts'), 'export function secret(): number {\n  return 0;\n}\n');
      fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(tmpDir, 'src', 'link.ts'));
      const symbols = await extractor.extract('src', tmpDir);
      expect(symbols.map((s) => s.name)).toEqual(['alpha']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('warns when a source file cannot be resolved (non-ENOENT)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = path.join(tmpDir, 'src', 'a.ts');
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p) === target) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p);
    });
    expect(await extractor.extract('src', tmpDir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot resolve source file'), expect.anything());
  });

  it('warns when a source file cannot be opened (non-ENOENT)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = path.join(tmpDir, 'src', 'a.ts');
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((p: any, flags: any): number => {
      if (String(p) === target) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p, flags);
    });
    expect(await extractor.extract('src', tmpDir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read source file'), expect.anything());
  });

  it('skips files whose stat fails during incremental filtering', async () => {
    const target = path.join(tmpDir, 'src', 'a.ts');
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (String(p) === target) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return real(p);
    });
    expect(await extractor.extract('src', tmpDir, Date.now() - 60_000)).toEqual([]);
  });
});

describe('extractTsJsDoc scan-up edges (via extractLeadingDocstring)', () => {
  it('stops at an earlier block close inside the candidate region', () => {
    const lines = [' * earlier */ close', ' * doc', ' */', 'function f() {}'];
    expect(extractLeadingDocstring(lines, 3, 'typescript')).toBeUndefined();
  });

  it('skips blank interior lines inside a JSDoc block', () => {
    const lines = ['/**', '', ' * doc', ' */', 'function f() {}'];
    const doc = extractLeadingDocstring(lines, 4, 'typescript');
    expect(doc).toContain('doc');
  });

  it('returns undefined when a non-comment line interrupts the candidate block', () => {
    const lines = ['random text', ' * doc', ' */', 'function f() {}'];
    expect(extractLeadingDocstring(lines, 3, 'typescript')).toBeUndefined();
  });

  it('returns undefined for a plain /* block (not a doc block)', () => {
    const lines = ['/* regular block', ' * note', ' */', 'function f() {}'];
    expect(extractLeadingDocstring(lines, 3, 'typescript')).toBeUndefined();
  });
});
