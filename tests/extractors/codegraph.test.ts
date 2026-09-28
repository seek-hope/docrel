import { describe, it, expect, vi, afterEach } from 'vitest';
import { CodegraphExtractor } from '../../src/extractors/codegraph.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';

function fakeClient(overrides: Partial<{ symbols: unknown[]; truncated: boolean; available: boolean }> = {}) {
  const explore = vi.fn().mockResolvedValue({
    symbols: overrides.symbols ?? [],
    truncated: overrides.truncated ?? false,
  });
  const isAvailable = vi.fn().mockResolvedValue(overrides.available ?? true);
  return { client: { explore, isAvailable } as unknown as CodegraphClient, explore, isAvailable };
}

describe('CodegraphExtractor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('queries codegraph with the directory and maps symbols', async () => {
    const { client, explore } = fakeClient({
      symbols: [
        { name: 'foo', kind: 'function', file: 'src/a.ts', line: 3, signature: 'foo()' },
        { name: 'Bar', kind: 'class', file: 'src/b.py', line: 1, signature: 'class Bar' },
      ],
    });
    const ex = new CodegraphExtractor(client, 25);

    const out = await ex.extract('src', '/proj');

    expect(explore).toHaveBeenCalledWith('symbols in src/', 25);
    expect(out).toEqual([
      { name: 'foo', kind: 'function', file: 'src/a.ts', line: 3, signature: 'foo()', language: 'typescript' },
      { name: 'Bar', kind: 'class', file: 'src/b.py', line: 1, signature: 'class Bar', language: 'python' },
    ]);
  });

  it('normalizes kind aliases and warns on unknown kinds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeClient({
      symbols: [
        { name: 'm', kind: 'method', file: 'a.rs', line: 1 },
        { name: 't', kind: 'type_alias', file: 'a.go', line: 2 },
        { name: 'n', kind: 'namespace', file: 'a.kt', line: 3 },
        { name: 'x', kind: 'quantum', file: 'a.ts', line: 4 },
      ],
    });
    const ex = new CodegraphExtractor(client);

    const out = await ex.extract('src', '/proj');

    expect(out.map((s) => s.kind)).toEqual(['method', 'type', 'module', 'function']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown symbol kind 'quantum'"));
  });

  it('detects languages from extensions and falls back sanely', async () => {
    const { client } = fakeClient({
      symbols: [
        { name: 'a', kind: 'function', file: 'x.tsx', line: 1 },
        { name: 'b', kind: 'function', file: 'x.cs', line: 1 },
        { name: 'c', kind: 'function', file: 'x.elixir', line: 1 },
        { name: 'd', kind: 'function', file: 'Makefile', line: 1 },
        { name: 'e', kind: 'function', file: 'x.', line: 1 },
      ],
    });
    const ex = new CodegraphExtractor(client);

    const out = await ex.extract('src', '/proj');

    expect(out.map((s) => s.language)).toEqual(['typescript', 'csharp', 'elixir', 'unknown', 'unknown']);
  });

  it('warns when the explore result is truncated', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeClient({ truncated: true });
    const ex = new CodegraphExtractor(client, 50);

    await ex.extract('src', '/proj');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('truncated'));
  });

  it('delegates availability to the client', async () => {
    const { client, isAvailable } = fakeClient({ available: false });
    const ex = new CodegraphExtractor(client);

    expect(await ex.isAvailable()).toBe(false);
    expect(isAvailable).toHaveBeenCalledTimes(1);
  });
});
