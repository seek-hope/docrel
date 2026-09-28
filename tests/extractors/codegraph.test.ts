// Tests for the codegraph index-backed extractor. Fixtures build a real
// .codegraph/codegraph.db (minimal nodes-table schema — the extractor only
// reads stable core columns) plus the referenced source files on disk.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { CodegraphExtractor } from '../../src/extractors/codegraph.js';
import { BuiltinExtractor } from '../../src/extractors/builtin.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';

interface NodeSpec {
  kind: string;
  name: string;
  file: string;
  line: number;
  language?: string;
  signature?: string;
}

const tmpDirs: string[] = [];

function fakeClient(available = true) {
  const isAvailable = vi.fn().mockResolvedValue(available);
  return { client: { isAvailable } as unknown as CodegraphClient, isAvailable };
}

/** Create a project dir with source files and a codegraph index DB. */
function makeProject(files: Record<string, string>, nodes: NodeSpec[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cgext-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  const cg = new Database(path.join(dir, '.codegraph', 'codegraph.db'));
  cg.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
    file_path TEXT NOT NULL, language TEXT NOT NULL,
    start_line INTEGER NOT NULL, signature TEXT)`);
  const ins = cg.prepare(
    'INSERT INTO nodes (id, kind, name, file_path, language, start_line, signature) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  nodes.forEach((n, i) => {
    ins.run(`n${i}`, n.kind, n.name, n.file, n.language ?? '', n.line, n.signature ?? null);
  });
  cg.close();
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('CodegraphExtractor (index enumeration)', () => {
  it('enumerates index nodes with signatures byte-identical to the builtin extractor', async () => {
    const source = [
      '/** Logs a user in. */',                                    // 1
      'export function login(',                                    // 2
      '  username: string,',                                       // 3
      '  password: string,',                                       // 4
      '): boolean {',                                              // 5
      '  return username.length > 0 && password.length > 0;',      // 6
      '}',                                                         // 7
      '',                                                          // 8
      'export const MAX_ATTEMPTS = 3;',                            // 9
      '',                                                          // 10
    ].join('\n');
    const root = makeProject({ 'src/auth.ts': source }, [
      { kind: 'function', name: 'login', file: 'src/auth.ts', line: 2, language: 'typescript' },
      { kind: 'constant', name: 'MAX_ATTEMPTS', file: 'src/auth.ts', line: 9, language: 'typescript' },
      // Non-symbol kinds exist in real indexes and must be excluded:
      { kind: 'import', name: 'fs', file: 'src/auth.ts', line: 1, language: 'typescript' },
      { kind: 'file', name: 'auth.ts', file: 'src/auth.ts', line: 1, language: 'typescript' },
      { kind: 'property', name: 'inner', file: 'src/auth.ts', line: 3, language: 'typescript' },
    ]);
    const { client } = fakeClient();

    const out = await new CodegraphExtractor(client).extract('src', root);
    const builtin = await new BuiltinExtractor().extract('src', root);

    // Same symbols, same order, byte-identical signature capture — switching
    // extractors must not register as a repository-wide signature change.
    expect(out).toEqual(builtin);
    expect(out.map((s) => [s.name, s.kind])).toEqual([
      ['login', 'function'],
      ['MAX_ATTEMPTS', 'variable'],
    ]);
    expect(out[0].docstring).toContain('Logs a user in.');
    expect(out[0].signature).toContain('password: string');
  });

  it('maps index kinds and warns on unknown kinds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cls = [
      'export class Widget {',   // 1
      '  render(): void {}',     // 2
      '}',                       // 3
      'export type Id = string;',// 4
      'export const q = 1;',     // 5
      '',
    ].join('\n');
    const root = makeProject({ 'src/w.ts': cls }, [
      { kind: 'class', name: 'Widget', file: 'src/w.ts', line: 1, language: 'typescript' },
      { kind: 'method', name: 'render', file: 'src/w.ts', line: 2, language: 'typescript' },
      { kind: 'type_alias', name: 'Id', file: 'src/w.ts', line: 4, language: 'typescript' },
      { kind: 'quantum', name: 'q', file: 'src/w.ts', line: 5, language: 'typescript' },
    ]);
    const out = await new CodegraphExtractor(fakeClient().client).extract('src', root);
    expect(out.map((s) => s.kind)).toEqual(['class', 'method', 'type', 'function']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown symbol kind 'quantum'"));
  });

  it('restricts enumeration to the requested directory; "." covers the whole repo', async () => {
    const src = 'export function a(): void {}\n';
    const root = makeProject({ 'src/a.ts': src, 'lib/b.ts': 'export function b(): void {}\n' }, [
      { kind: 'function', name: 'a', file: 'src/a.ts', line: 1, language: 'typescript' },
      { kind: 'function', name: 'b', file: 'lib/b.ts', line: 1, language: 'typescript' },
    ]);
    const ex = new CodegraphExtractor(fakeClient().client);
    expect((await ex.extract('src', root)).map((s) => s.name)).toEqual(['a']);
    expect((await ex.extract('.', root)).map((s) => s.name)).toEqual(['b', 'a']); // file_path order
  });

  it('falls back to extension-based language detection when the row has no language', async () => {
    const root = makeProject({ 'src/x.cs': 'class C {}\n' }, [
      { kind: 'class', name: 'C', file: 'src/x.cs', line: 1 },
    ]);
    const out = await new CodegraphExtractor(fakeClient().client).extract('src', root);
    expect(out[0].language).toBe('csharp');
  });

  it('throws an actionable error when the index is missing', async () => {
    const root = makeProject({ 'src/a.ts': 'export function a(): void {}\n' }, []);
    fs.rmSync(path.join(root, '.codegraph', 'codegraph.db'));
    await expect(new CodegraphExtractor(fakeClient().client).extract('src', root))
      .rejects.toThrow('codegraph init');
  });

  it('throws an actionable error when the index has no nodes table', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cgext-'));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    new Database(path.join(root, '.codegraph', 'codegraph.db')).close(); // valid DB, no schema
    await expect(new CodegraphExtractor(fakeClient().client).extract('src', root))
      .rejects.toThrow('unrecognized schema');
  });

  it('skips nodes whose source file vanished (stale index) and keeps the rest', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = makeProject({ 'src/a.ts': 'export function a(): void {}\n' }, [
      { kind: 'function', name: 'a', file: 'src/a.ts', line: 1, language: 'typescript' },
      { kind: 'function', name: 'ghost', file: 'src/gone.ts', line: 1, language: 'typescript' },
    ]);
    const out = await new CodegraphExtractor(fakeClient().client).extract('src', root);
    expect(out.map((s) => s.name)).toEqual(['a']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('src/gone.ts'));
  });

  it('uses the index signature fragment for out-of-range start lines instead of throwing', async () => {
    const root = makeProject({ 'src/a.ts': 'export function a(): void {}\n' }, [
      { kind: 'function', name: 'a', file: 'src/a.ts', line: 999, language: 'typescript', signature: '(): void' },
    ]);
    const out = await new CodegraphExtractor(fakeClient().client).extract('src', root);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'a', line: 999, signature: '(): void' });
    expect(out[0]).not.toHaveProperty('raw_signature');
  });

  it('delegates availability to the client', async () => {
    const { client, isAvailable } = fakeClient(false);
    expect(await new CodegraphExtractor(client).isAvailable()).toBe(false);
    expect(isAvailable).toHaveBeenCalledTimes(1);
  });
});
