import { describe, it, expect, vi, afterEach } from 'vitest';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';

describe('hash utilities — guards and stability', () => {
  afterEach(() => vi.restoreAllMocks());

  it('symbolId returns empty string with a warning on null/undefined input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(symbolId(null as never, 'a::b', 'function')).toBe('');
    expect(symbolId('ts', undefined as never, 'function')).toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('docSectionId returns empty string with a warning on null/undefined input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(docSectionId(null as never, 'anchor')).toBe('');
    expect(docSectionId('file.md', undefined as never)).toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('symbolId is case/whitespace-normalized and stable', () => {
    const a = symbolId('TypeScript', ' src/a.ts::login ', 'Function');
    const b = symbolId('typescript', 'src/a.ts::login', 'function');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('docSectionId encodes # so components stay unambiguous', () => {
    const x = docSectionId('README.md#Section', '1');
    const y = docSectionId('README.md', 'Section#1');
    expect(x).not.toBe(y);
  });

  it('contentHash coerces non-string and null input instead of throwing', () => {
    expect(contentHash(null as never)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(42 as never)).toBe(contentHash('42'));
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });
});
