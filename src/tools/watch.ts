// src/tools/watch.ts — file watcher for non-agent scenarios
import type Database from 'better-sqlite3';
import type { SymbolExtractor } from '../extractors/interface.js';
import type { DocRelConfig } from '../utils/config.js';
import { scanProject } from '../discovery/scanner.js';
import { scanDocs } from '../discovery/doc-scanner.js';
import { autoLink } from '../discovery/auto-linker.js';
import { upsertDocSection } from '../db/docs.js';
import { docSectionId, contentHash } from '../utils/hash.js';
import { listSymbols } from '../db/symbols.js';
import { isIgnored } from '../utils/ignore.js';
import fs from 'node:fs';
import path from 'node:path';

interface WatchOptions {
  /** Debounce delay in milliseconds (default 500ms) */
  debounceMs?: number;
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
  config: DocRelConfig,
  opts: WatchOptions = {},
): Promise<() => void> {
  const debounceMs = opts.debounceMs ?? 500;

  try {
    const chokidar = await import('chokidar');
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Gather watch paths
    const watchPaths: string[] = [];
    for (const dir of config.code_dirs) {
      const p = path.join(projectRoot, dir);
      if (fs.existsSync(p)) watchPaths.push(p);
    }
    for (const dir of config.doc_dirs) {
      const p = path.join(projectRoot, dir);
      if (fs.existsSync(p)) watchPaths.push(p);
    }

    if (watchPaths.length === 0) {
      console.error('No directories to watch. Set code_dirs and doc_dirs in .docrel/config.yaml');
      return () => {};
    }

    console.log(`Watching ${watchPaths.length} path(s): ${watchPaths.join(', ')}`);

    const watcher = chokidar.watch(watchPaths, {
      ignored: /(^|[/\\])\./,  // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    });

    const handleChange = (eventType: string, filePath: string) => {
      const rel = path.relative(projectRoot, filePath);

      // Skip files matching .docrelignore patterns
      if (isIgnored(rel, projectRoot)) return;

      const inCode = config.code_dirs.some(d => rel.startsWith(d));

      // Debounce: group rapid changes
      const key = inCode ? 'code' : 'docs';
      if (debounceTimers.has(key)) {
        clearTimeout(debounceTimers.get(key)!);
      }

      debounceTimers.set(key, setTimeout(async () => {
        debounceTimers.delete(key);
        const now = new Date().toLocaleTimeString();

        try {
          if (inCode) {
            console.log(`[${now}] Code change: ${rel} — re-scanning symbols...`);
            const report = await scanProject(extractor, db, config, projectRoot);
            // Auto-link against existing docs
            const symbols = listSymbols(db);
            const { sections: docs } = await scanDocs(config.doc_dirs, projectRoot);
            for (const section of docs) {
              upsertDocSection(db, {
                id: docSectionId(section.file, section.anchor),
                file: section.file,
                anchor: section.anchor,
                content_hash: contentHash(section.content),
                doc_type: 'standalone',
              });
            }
            const linkResult = autoLink(db, symbols, docs);
            console.log(`[${now}] Re-scanned: ${report.newSymbols} new symbols, ${linkResult.totalMatched} new mappings`);
          } else {
            console.log(`[${now}] Doc change: ${rel} — re-scanning docs...`);
            const { sections: docs } = await scanDocs(config.doc_dirs, projectRoot);
            for (const section of docs) {
              upsertDocSection(db, {
                id: docSectionId(section.file, section.anchor),
                file: section.file,
                anchor: section.anchor,
                content_hash: contentHash(section.content),
                doc_type: 'standalone',
              });
            }
            const symbols = listSymbols(db);
            const linkResult = autoLink(db, symbols, docs);
            console.log(`[${now}] Re-scanned: ${docs.length} doc sections, ${linkResult.totalMatched} new mappings`);
          }
        } catch (err: any) {
          console.error(`[${now}] Watch error: ${err.message}`);
        }
      }, debounceMs));
    };

    watcher.on('add', (p: string) => handleChange('add', p));
    watcher.on('change', (p: string) => handleChange('change', p));
    watcher.on('unlink', (p: string) => {
      const now = new Date().toLocaleTimeString();
      console.log(`[${now}] File removed: ${path.relative(projectRoot, p)}`);
    });

    watcher.on("error", (err: any) => {
      console.error(`Watch error: ${err.message}`);
    });

    console.log('DocRel watch is running. Press Ctrl+C to stop.');

    return () => {
      watcher.close();
      for (const t of debounceTimers.values()) clearTimeout(t);
      console.log('DocRel watch stopped.');
    };
  } catch (err: any) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
      console.error('chokidar is not installed. Run: npm install -g chokidar');
    } else {
      console.error('DocRel watch failed to start:', err instanceof Error ? err.message : err);
    }
    return () => {};
  }
}
