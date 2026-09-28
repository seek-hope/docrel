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
