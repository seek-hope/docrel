// src/tools/watch.ts — file watcher for non-agent scenarios
import type Database from 'better-sqlite3';
import type { SymbolExtractor } from '../extractors/interface.js';
import type { DocRelayConfig } from '../utils/config.js';
import { readLastScanAt } from '../discovery/scanner.js';
import { runDocsPipeline, scanWithFallback } from '../cli-support.js';
import { isIgnored } from '../utils/ignore.js';
import { escapeLike } from '../utils/fs.js';
import fs from 'node:fs';
import path from 'node:path';

interface WatchOptions {
  /** Debounce delay in milliseconds (default 500ms) */
  debounceMs?: number;
  /** Write a PID file for daemon management (default false) */
  daemon?: boolean;
}

export interface WatchStatus {
  running: boolean;
  pid?: number;
  pidFile?: string;
  startedAt?: string;
  watchPaths: string[];
  lastEventAt?: string;
  eventsProcessed: number;
  errorsEncountered: number;
  lastError?: string;
}

let watchStatus: WatchStatus = {
  running: false,
  watchPaths: [],
  eventsProcessed: 0,
  errorsEncountered: 0,
};

/** Get the current watch status for health checks and monitoring. */
export function getWatchStatus(): WatchStatus {
  return { ...watchStatus };
}

/**
 * Start a file watcher that re-scans symbols/docs on file changes.
 * Returns a cleanup function to stop watching.
 *
 * Requires chokidar to be installed (npm dependency).
 */
export async function startWatch(
  projectRoot: string,
  db: Database.Database,
  extractor: SymbolExtractor,
  config: DocRelayConfig,
  opts: WatchOptions = {},
): Promise<() => void> {
  const debounceMs = opts.debounceMs ?? 500;

  try {
    const chokidar = await import('chokidar');
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Gather watch paths (with path-traversal containment check)
    const watchPaths: string[] = [];
    const root = path.resolve(projectRoot);
    for (const dir of config.code_dirs) {
      const p = path.join(projectRoot, dir);
      const absDir = path.resolve(p);
      if (!absDir.startsWith(root + path.sep) && absDir !== root) {
        console.warn(`Watch: code_dir '${dir}' is outside project root — skipping`);
        continue;
      }
      if (fs.existsSync(p)) watchPaths.push(p);
    }
    for (const dir of config.doc_dirs) {
      const p = path.join(projectRoot, dir);
      const absDir = path.resolve(p);
      if (!absDir.startsWith(root + path.sep) && absDir !== root) {
        console.warn(`Watch: doc_dir '${dir}' is outside project root — skipping`);
        continue;
      }
      if (fs.existsSync(p)) watchPaths.push(p);
    }

    if (watchPaths.length === 0) {
      console.error('No directories to watch. Set code_dirs and doc_dirs in .docrelay/config.yaml');
      return () => {};
    }

    // Daemon mode: write PID file for process management
    let pidFile: string | undefined;
    if (opts.daemon) {
      const pidDir = path.join(projectRoot, '.docrelay');
      try { fs.mkdirSync(pidDir, { recursive: true, mode: 0o700 }); } catch { /* ok */ }
      pidFile = path.join(pidDir, 'watch.pid');
      fs.writeFileSync(pidFile, String(process.pid), { flag: 'w', mode: 0o600 });
    }

    // Update global watch status
    watchStatus = {
      running: true,
      pid: process.pid,
      pidFile,
      startedAt: new Date().toISOString(),
      watchPaths,
      eventsProcessed: 0,
      errorsEncountered: 0,
    };

    console.log(`Watching ${watchPaths.length} path(s): ${watchPaths.join(', ')}`);

    const watcher = chokidar.watch(watchPaths, {
      ignored: /(^|[/\\])\./,  // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    });

    /** Group watch events by the nearest watch-path parent directory for
     *  finer-grained debouncing. A change in src/auth/ and a change in
     *  src/api/ should NOT cancel each other's debounce timer. */
    function groupKey(filePath: string): string {
      const rel = path.relative(projectRoot, filePath);
      const inCode = config.code_dirs.some(d => rel.startsWith(d));
      // Find the top-level directory within the project root
      const topDir = rel.split(path.sep)[0] || rel;
      return `${inCode ? 'code' : 'docs'}/${topDir}`;
    }

    // Serialize debounced scans across groups. Debounce timers are per-group,
    // so two groups can fire while an earlier scan is still running — and two
    // concurrent scans would read the same pre-scan state and duplicate
    // changelog/symbol-created rows, interleave writes, and double-hit the
    // codegraph stdio client. Chaining onto the previous scan's promise keeps
    // per-group debounce but makes execution strictly serial. The second
    // callback keeps the chain alive even if a task ever rejected (bodies are
    // try/catch wrapped, so this is defense-in-depth).
    let scanChain: Promise<void> = Promise.resolve();
    const enqueueScan = (task: () => Promise<void>): void => {
      scanChain = scanChain.then(task, task);
    };

    const handleChange = (eventType: string, filePath: string) => {
      const rel = path.relative(projectRoot, filePath);

      // Skip files matching .docrelayignore patterns
      if (isIgnored(rel, projectRoot)) return;

      const inCode = config.code_dirs.some(d => rel.startsWith(d));
      const key = groupKey(filePath);

      // Debounce by directory group — events in different groups don't cancel each other
      if (debounceTimers.has(key)) {
        clearTimeout(debounceTimers.get(key));
      }

      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        enqueueScan(async () => {
        watchStatus.eventsProcessed++;
        watchStatus.lastEventAt = new Date().toISOString();
        const now = new Date().toLocaleTimeString();

        try {
          if (inCode) {
            console.log(`[${now}] Code change (${key}): ${rel} — re-scanning symbols...`);
            // Read the watermark BEFORE scanProject overwrites it; the docs
            // pipeline delta-filters ingest/auto-link against it, so a
            // one-file code edit no longer triggers a full O(symbols ×
            // sections) re-link on every debounced event.
            const prevScanAt = readLastScanAt(db);
            // scanWithFallback: a present-but-unindexed codegraph would
            // otherwise yield 0 symbols and the watcher would silently never
            // update symbols (same fallback semantics as the CLI scan).
            const report = await scanWithFallback(extractor, db, config, projectRoot, false /* incremental */);
            const pipeline = await runDocsPipeline(db, config, projectRoot, prevScanAt, report.scannedIds);
            console.log(`[${now}] Done: ${pipeline.autoLink.totalMatched} new mappings`);
          } else {
            console.log(`[${now}] Doc change (${key}): ${rel} — re-scanning docs...`);
            // scannedIds=[] keeps pass 1 off (no symbols changed); pass 2
            // links all symbols against just the changed doc sections.
            // NOTE: deliberately does NOT move the last_scan_at watermark —
            // it belongs to the symbol scan; touching it for a doc-only
            // event would let the next incremental symbol scan skip code
            // files edited since the real scan.
            const pipeline = await runDocsPipeline(db, config, projectRoot, readLastScanAt(db), []);
            console.log(`[${now}] Done: ${pipeline.autoLink.totalMatched} new mappings`);
          }
        } catch (err: any) {
          watchStatus.errorsEncountered++;
          watchStatus.lastError = err instanceof Error ? err.message : String(err);
          console.error(`[${now}] Watch error (${key}): ${err instanceof Error ? err.message : err}`);

          // Write a recovery marker so `doc-relay status` can surface the failure
          try {
            const markerDir = path.join(projectRoot, '.docrelay');
            fs.mkdirSync(markerDir, { recursive: true });
            fs.writeFileSync(path.join(markerDir, 'watch-failed'), JSON.stringify({
              at: new Date().toISOString(),
              error: err instanceof Error ? err.message : String(err),
            }));
          } catch { /* best-effort marker */ }
        }
        });
      }, debounceMs));
    };

    watcher.on('add', (p: string) => handleChange('add', p));
    watcher.on('change', (p: string) => handleChange('change', p));
    watcher.on('unlink', (p: string) => {
      watchStatus.eventsProcessed++;
      watchStatus.lastEventAt = new Date().toISOString();
      const now = new Date().toLocaleTimeString();
      const rel = path.relative(projectRoot, p);
      console.log(`[${now}] File removed: ${rel}`);

      // Mark linked docs as stale when a source file is deleted.
      // Without this, deleted symbols persist until the next explicit gc run
      // (two-pass: first gc marks stale, second gc deletes). The watcher
      // should surface the impact immediately so the developer sees stale docs
      // in doc-relay status and can run gc to clean up.
      try {
        // Find symbols whose location starts with this file path.
        // Cap at 1000 to prevent pathological DB queries from blocking the
        // event loop — large repos should use explicit gc instead.
        const affectedSymbols = db.prepare(
          `SELECT id FROM symbols WHERE location LIKE ? || ':%' ESCAPE '\\' LIMIT 1000`
        ).all(escapeLike(rel)) as Array<{ id: string }>;
        if (affectedSymbols.length > 0) {
          // Mark mappings for affected symbols as stale
          const markMappingStale = db.prepare(
            "UPDATE mappings SET review_status = 'auto' WHERE symbol_id = ? AND review_status = 'confirmed'"
          );
          // Same evidence gate as markDocsStaleForSymbol (confirmed or
          // confidence >= 0.7, never rejected) — previously this also staled
          // docs through REJECTED and weak auto mappings.
          const markDocStale = db.prepare(
            `UPDATE doc_sections SET status = 'stale', updated_at = datetime('now')
             WHERE id IN (
               SELECT doc_id FROM mappings
               WHERE symbol_id = ? AND review_status != 'rejected'
                 AND (review_status = 'confirmed' OR confidence >= 0.7)
             )`
          );
          const txn = db.transaction(() => {
            for (const sym of affectedSymbols) {
              markMappingStale.run(sym.id);
              markDocStale.run(sym.id);
            }
          });
          txn();
          console.log(`[${now}] File removed: ${rel} — ${affectedSymbols.length} symbol(s) affected, docs marked stale`);
        }
      } catch (err: any) {
        watchStatus.errorsEncountered++;
        watchStatus.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[${now}] Error processing file removal ${rel}: ${err instanceof Error ? err.message : err}`);
      }
    });

    watcher.on("error", (err: any) => {
      watchStatus.errorsEncountered++;
      watchStatus.lastError = err instanceof Error ? err.message : String(err);
      console.error(`Watch error: ${err?.message ?? err}`);
    });

    // Handle chokidar close — the watcher may die after a fatal error
    // (EMFILE, ENOSPC, filesystem unmount). Log prominently and write a
    // recovery marker so `doc-relay status` can surface the failure.
    // chokidar's 'close' event is not in the typed FSWatcherEventMap, but
    // FSWatcher extends EventEmitter and emits it at runtime.
    (watcher as any).on("close", () => {
      watchStatus.running = false;
      watchStatus.lastError = 'Filesystem watcher closed unexpectedly — restart with `doc-relay watch`';
      console.error('DocRelay: filesystem watcher closed unexpectedly. Docs may become stale. Re-run `doc-relay watch` to resume.');
      try {
        const markerDir = path.join(projectRoot, '.docrelay');
        fs.mkdirSync(markerDir, { recursive: true });
        fs.writeFileSync(path.join(markerDir, 'watch-crashed'), JSON.stringify({
          at: new Date().toISOString(),
          eventsProcessed: watchStatus.eventsProcessed,
          errorsEncountered: watchStatus.errorsEncountered,
        }));
      } catch { /* best-effort marker */ }
    });

    console.log('DocRelay watch is running. Press Ctrl+C to stop.');

    return () => {
      void watcher.close();
      for (const t of debounceTimers.values()) clearTimeout(t);
      // Remove PID file on clean shutdown
      if (pidFile) {
        try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
      }
      watchStatus.running = false;
      console.log('DocRelay watch stopped.');
    };
  } catch (err: any) {
    watchStatus.running = false;
    watchStatus.lastError = err instanceof Error ? err.message : String(err);
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
      console.error('chokidar is not installed. Run: npm install -g chokidar');
    } else {
      console.error('DocRelay watch failed to start:', err instanceof Error ? err.message : err);
    }
    return () => {};
  }
}
