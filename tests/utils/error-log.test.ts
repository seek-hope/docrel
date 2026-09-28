import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The debug flag is read from the environment at module load, so each test
 * re-imports the module fresh after setting DOCRELAY_DEBUG.
 */
async function importFresh(): Promise<typeof import('../../src/utils/error-log.js')> {
  vi.resetModules();
  return import('../../src/utils/error-log.js');
}

describe('utils/error-log', () => {
  let errs: string[];
  const savedDebug = process.env.DOCRELAY_DEBUG;

  beforeEach(() => {
    errs = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  });

  afterEach(() => {
    if (savedDebug === undefined) delete process.env.DOCRELAY_DEBUG;
    else process.env.DOCRELAY_DEBUG = savedDebug;
    vi.restoreAllMocks();
  });

  it('logs a one-line sanitized message without a stack by default', async () => {
    delete process.env.DOCRELAY_DEBUG;
    const { logInternalError, DOCRELAY_DEBUG } = await importFresh();
    expect(DOCRELAY_DEBUG).toBe(false);

    logInternalError('docrelayCheck failed', new Error('db exploded'));

    expect(errs).toHaveLength(1);
    expect(errs[0]).toBe('DocRelay: docrelayCheck failed: db exploded');
    expect(errs[0]).not.toContain('    at ');
  });

  it('appends the stack when DOCRELAY_DEBUG is set', async () => {
    process.env.DOCRELAY_DEBUG = '1';
    const { logInternalError, DOCRELAY_DEBUG } = await importFresh();
    expect(DOCRELAY_DEBUG).toBe(true);

    logInternalError('uncaught exception', new Error('boom'));

    expect(errs[0]).toBe('DocRelay: uncaught exception: boom');
    expect(errs[1]).toContain('DocRelay: uncaught exception (debug stack):');
    expect(errs[1]).toContain('    at ');
  });

  it("treats 'true' as enabled and other values as disabled", async () => {
    process.env.DOCRELAY_DEBUG = 'true';
    expect((await importFresh()).DOCRELAY_DEBUG).toBe(true);
    process.env.DOCRELAY_DEBUG = 'yes';
    expect((await importFresh()).DOCRELAY_DEBUG).toBe(false);
  });

  it('stringifies non-Error throws defensively', async () => {
    delete process.env.DOCRELAY_DEBUG;
    const { logInternalError } = await importFresh();

    logInternalError('weird', 'plain string failure');
    logInternalError('weird', 42);

    expect(errs[0]).toBe('DocRelay: weird: plain string failure');
    expect(errs[1]).toBe('DocRelay: weird: 42');
  });
});
