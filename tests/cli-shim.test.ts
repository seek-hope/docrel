/**
 * cli.ts is a thin entry shim around cli-main.ts: a missing better-sqlite3
 * native binding (npm >= 12 skipping install scripts) must surface as
 * actionable guidance + exit 1, while unrelated startup errors propagate
 * unchanged. Fault injection mocks the cli-main module itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class ExitSignal extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

let errs: string[];
const savedArgv = process.argv;

beforeEach(() => {
  errs = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code ?? 0); }) as never);
  process.argv = ['node', 'docrelay', '--version'];
});

afterEach(() => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
});

describe('cli entry shim', () => {
  it('prints remediation guidance when the sqlite native binding is missing', async () => {
    vi.doMock('../src/cli-main.js', () => {
      throw new Error('Could not locate the bindings file. Tried: /x/better_sqlite3.node');
    });
    vi.resetModules();
    await expect(import('../src/cli.js')).rejects.toThrow(ExitSignal);
    const out = errs.join('\n');
    expect(out).toContain('native binding was not built');
    expect(out).toContain('npm rebuild better-sqlite3');
    expect(out).toContain('--allow-scripts=better-sqlite3');
    vi.doUnmock('../src/cli-main.js');
  });

  it('rethrows unrelated startup errors unchanged', async () => {
    const boom = new Error('totally unrelated boom');
    vi.doMock('../src/cli-main.js', () => {
      throw boom;
    });
    vi.resetModules();
    // vitest wraps factory-thrown errors in its own mocking error with the
    // original on .cause — the shim must rethrow rather than misclassify.
    let caught: unknown;
    try {
      await import('../src/cli.js');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect((caught as { cause?: unknown }).cause ?? caught).toBe(boom);
    expect(errs.join('\n')).not.toContain('native binding');
    vi.doUnmock('../src/cli-main.js');
  });
});
