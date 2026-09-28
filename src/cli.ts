#!/usr/bin/env node
/**
 * Entry shim for the `doc-relay` / `docrelay` binaries.
 *
 * The real CLI lives in cli-main.ts and is imported dynamically so that a
 * missing better-sqlite3 native binding surfaces as actionable guidance
 * instead of a raw "Could not locate the bindings file" stack trace. This
 * happens in the wild when install scripts are skipped — npm >= 12 blocks
 * them by default for global installs (npm install -g doc-relay), where
 * the package's own allowScripts declaration does not apply.
 */

/** True when the failure is better-sqlite3 reporting a missing native binding. */
function isMissingSqliteBinding(err: unknown): boolean {
  // Walk the cause chain: module loaders, bundlers, and test runners may
  // wrap the original binding error in their own error type.
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const msg =
      cur instanceof Error
        ? `${cur.message}\n${cur.stack ?? ''}`
        : typeof cur === 'string'
          ? cur
          : JSON.stringify(cur) ?? '';
    if (msg.includes('better_sqlite3.node') || msg.includes('Could not locate the bindings file')) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

try {
  await import('./cli-main.js');
} catch (err) {
  if (isMissingSqliteBinding(err)) {
    console.error(
      'DocRelay cannot start: the better-sqlite3 native binding was not built.\n' +
        'This usually means install scripts were skipped (npm >= 12 blocks them by default).\n' +
        'Fix it with one of:\n' +
        '  npm rebuild better-sqlite3\n' +
        '  npm install -g doc-relay --allow-scripts=better-sqlite3\n' +
        'or allow it permanently: npm config set allow-scripts better-sqlite3',
    );
    process.exit(1);
  }
  throw err;
}
