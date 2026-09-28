import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProgressReporter } from '../../src/utils/progress.js';

describe('createProgressReporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Restore the real TTY flag in case a test overrode it.
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true, writable: true });
  });

  function withTty(): ReturnType<typeof vi.spyOn> {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true, writable: true });
    return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  it('is a no-op when stderr is not a TTY', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true, writable: true });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const report = createProgressReporter(100, 'Scanning');
    report(50);
    report(100);
    expect(write).not.toHaveBeenCalled();
  });

  it('is a no-op when total is zero', () => {
    const write = withTty();
    const report = createProgressReporter(0, 'Scanning');
    report(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('reports on first tick, then only when crossing an interval boundary', () => {
    const write = withTty();
    const report = createProgressReporter(100, 'Scanning', 25);
    report(10);  // first tick always reports
    expect(write).toHaveBeenCalledTimes(1);
    report(20);  // 20% — no new 25%-boundary crossed since the 10% report
    expect(write).toHaveBeenCalledTimes(1);
    report(30);  // crosses the 25% boundary
    expect(write).toHaveBeenCalledTimes(2);
    report(40);  // no new boundary
    expect(write).toHaveBeenCalledTimes(2);
    report(55);  // crosses 50%
    expect(write).toHaveBeenCalledTimes(3);
    const out = (write.mock.calls as unknown[][]).map((c) => String(c[0])).join('');
    expect(out).toContain('Scanning... 10/100 (10%)');
    expect(out).toContain('Scanning... 30/100 (30%)');
    expect(out).toContain('Scanning... 55/100 (55%)');
  });

  it('always reports at 100% and terminates with a newline', () => {
    const write = withTty();
    const report = createProgressReporter(3, 'Docs', 50);
    report(3); // 100% despite interval=50
    const calls = (write.mock.calls as unknown[][]).map((c) => String(c[0]));
    expect(calls[0]).toContain('3/3 (100%)');
    expect(calls.some((c: string) => c === '\n')).toBe(true);
  });
});
