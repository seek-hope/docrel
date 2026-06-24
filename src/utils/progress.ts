/**
 * Shared progress reporter for CLI scan operations.
 * Logs progress to stderr every `interval` percent. Only active when stderr
 * is a TTY — no noise when piped or redirected.
 */
export function createProgressReporter(total: number, label: string, interval: number = 5) {
  if (!process.stderr.isTTY || total === 0) return () => {};

  let lastReportedPercent = -interval;

  return (current: number) => {
    const pct = Math.round((current / total) * 100);
    // Report when pct crosses the next interval threshold (or at 100%).
    if (pct >= lastReportedPercent + interval || pct >= 100) {
      lastReportedPercent = Math.floor(pct / interval) * interval;
      process.stderr.write(`\r${label}... ${current}/${total} (${pct}%)`);
      if (pct >= 100) process.stderr.write('\n');
    }
  };
}
