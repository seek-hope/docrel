import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { updateGeneratedDoc, detectGenerator } from '../../src/sync/generated.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('updateGeneratedDoc — command validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  const rejected = [
    'bash -c echo hi',                    // interpreter not allowlisted
    'evilbinary',                         // unknown binary
    '/usr/bin/typedoc',                   // absolute path rejected
    './node_modules/.bin/typedoc',        // relative path rejected
    'typedoc --plugin ./evil.ts',         // code-loading flag
    'typedoc -p ./evil.ts',
    'typedoc --options typedoc.json',
    'typedoc --tsconfig tsconfig.json',
    'typedoc --plugin=./evil.ts',
    'typedoc --out docs; rm -rf /',       // shell metacharacter
    'npm',                                // incomplete npm command
    'npm install',                        // not `npm run`
    'npm run not-allowed-script',         // script not on allowlist
    'npm run docs:generate -- --evil',    // extra args rejected
    '',                                   // empty
    '   ',                                // whitespace only
  ];

  for (const cmd of rejected) {
    it(`rejects: ${JSON.stringify(cmd)}`, () => {
      const result = updateGeneratedDoc({ file: 'docs/api.md', generator: cmd, projectRoot: '/tmp' });
      expect(result.success).toBe(false);
      expect(result.output).toContain('rejected by security validation');
    });
  }

  it('rejects commands with too many arguments', () => {
    const cmd = 'typedoc ' + Array.from({ length: 60 }, (_, i) => `--arg${i}`).join(' ');
    const result = updateGeneratedDoc({ file: 'docs/api.md', generator: cmd, projectRoot: '/tmp' });
    expect(result.success).toBe(false);
  });
});

describe('updateGeneratedDoc — execution', () => {
  let tmpDir: string;
  let binDir: string;
  let savedPath: string | undefined;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-gen-'));
    binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs an allowlisted generator and returns its output', () => {
    fs.writeFileSync(path.join(binDir, 'typedoc'), '#!/bin/sh\necho "docs generated ok"\n', { mode: 0o755 });

    const result = updateGeneratedDoc({ file: 'docs/api.md', generator: 'typedoc --out docs', projectRoot: tmpDir });

    expect(result.success).toBe(true);
    expect(result.output).toContain('docs generated ok');
  });

  it('reports non-zero exits without leaking full output', () => {
    fs.writeFileSync(path.join(binDir, 'typedoc'), '#!/bin/sh\necho "diagnostics" >&2\nexit 3\n', { mode: 0o755 });

    const result = updateGeneratedDoc({ file: 'docs/api.md', generator: 'typedoc', projectRoot: tmpDir });

    expect(result.success).toBe(false);
    expect(result.output).toContain('exited with code 3');
    expect(result.output).not.toContain('diagnostics');
    expect(errSpy).toHaveBeenCalled();
  });

  it('reports spawn errors when the binary is missing', () => {
    const result = updateGeneratedDoc({ file: 'docs/api.md', generator: 'typedoc', projectRoot: tmpDir });

    expect(result.success).toBe(false);
    expect(result.output).toContain('Generator failed');
  });
});

describe('detectGenerator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-detect-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePkg(pkg: unknown): void {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg), 'utf-8');
  }

  it('returns null when package.json is missing', () => {
    expect(detectGenerator('docs/api.md', tmpDir)).toBeNull();
  });

  it('returns null for an oversized package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"a":"' + 'x'.repeat(1_100_000) + '"}', 'utf-8');
    expect(detectGenerator('docs/api.md', tmpDir)).toBeNull();
  });

  it('returns null for a deeply nested package.json', () => {
    const deep = '{"a":'.repeat(201) + '1' + '}'.repeat(201);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), deep, 'utf-8');
    expect(detectGenerator('docs/api.md', tmpDir)).toBeNull();
  });

  it('ignores brackets inside strings when measuring nesting depth', () => {
    // Depth would exceed 200 if string contents were miscounted.
    const tricky = '{"scripts":{"docs:generate":"' + '['.repeat(300) + '"}}';
    fs.writeFileSync(path.join(tmpDir, 'package.json'), tricky, 'utf-8');
    expect(detectGenerator('docs/api.md', tmpDir)).toBe('npm run docs:generate');
  });

  it('returns null for invalid JSON or non-object JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{oops', 'utf-8');
    expect(detectGenerator('docs/api.md', tmpDir)).toBeNull();

    fs.writeFileSync(path.join(tmpDir, 'package.json'), '[1,2,3]', 'utf-8');
    expect(detectGenerator('docs/api.md', tmpDir)).toBeNull();
  });

  it('detects OpenAPI specs by filename and prefers type-specific scripts', () => {
    writePkg({ scripts: { 'docs:generate': 'echo docs', 'generate:openapi': 'echo api' } });
    expect(detectGenerator('docs/openapi.yaml', tmpDir)).toBe('npm run generate:openapi');
  });

  it('detects OpenAPI specs by content header when the filename is generic', () => {
    writePkg({ scripts: { 'generate:api': 'echo api' } });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'spec.yaml'), 'openapi: "3.0.0"\ninfo:\n  title: API\n', 'utf-8');

    expect(detectGenerator('docs/spec.yaml', tmpDir)).toBe('npm run generate:api');
  });

  it('does not treat ordinary yaml files as OpenAPI specs', () => {
    writePkg({ scripts: {} });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'ci.yaml'), 'name: ci\non: push\n', 'utf-8');

    expect(detectGenerator('docs/ci.yaml', tmpDir)).toBeNull();
  });

  it('rejects traversal file paths during content sniffing', () => {
    writePkg({ scripts: { 'generate:api': 'echo api' } });
    // Filename heuristics never read the file — the path is only matched
    // against name patterns, so traversal in a heuristic-matched name is
    // benign and still resolves to the npm script.
    expect(detectGenerator('../../etc/openapi-outside.yaml', tmpDir)).toBe('npm run generate:api');
    // Content sniffing opens the file — traversal must be rejected there.
    expect(detectGenerator('../outside.yaml', tmpDir)).toBeNull();
  });

  it('detects TypeDoc markdown targets', () => {
    writePkg({ scripts: { 'docs:generate': 'typedoc' } });
    expect(detectGenerator('docs/reference/typedoc-api.md', tmpDir)).toBe('npm run docs:generate');
  });

  it('falls back to any allowlisted script for other files', () => {
    writePkg({ scripts: { 'build:docs': 'echo build' } });
    expect(detectGenerator('README.md', tmpDir)).toBe('npm run build:docs');
  });

  it('returns null when no allowlisted script exists', () => {
    writePkg({ scripts: { test: 'vitest', 'make:docs': 'echo nope' } });
    expect(detectGenerator('docs/typedoc-api.md', tmpDir)).toBeNull();
  });
});
