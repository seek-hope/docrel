import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { createMapping } from '../../src/db/mappings.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { startWatch, getWatchStatus } from '../../src/tools/watch.js';
import { scanProject } from '../../src/discovery/scanner.js';
import { BuiltinExtractor } from '../../src/extractors/builtin.js';
import { docSectionId } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeConfig(projectRoot: string, overrides: Partial<DocRelayConfig> = {}): DocRelayConfig {
  return {
    version: 1,
    project: projectRoot,
    doc_dirs: ['docs'],
    code_dirs: ['src'],
    strategies: {
      inline: 'auto_update',
      standalone: 'auto_update',
      generated: 'auto_update',
      architecture: 'mark_stale',
    },
    ...overrides,
  };
}

describe('startWatch', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-watch-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a stopped status before any watcher starts', () => {
    const status = getWatchStatus();
    expect(status.running).toBe(false);
    expect(status.eventsProcessed).toBe(0);
    expect(status.errorsEncountered).toBe(0);
  });

  it('fails cleanly when no watch directories exist', async () => {
    const config = makeConfig(tmpDir, { code_dirs: ['no-such-src'], doc_dirs: ['no-such-docs'] });
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), config);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No directories to watch'));
    expect(getWatchStatus().running).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it('skips configured dirs that escape the project root', async () => {
    const config = makeConfig(tmpDir, { code_dirs: ['../outside'], doc_dirs: [] });
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), config);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("outside project root"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No directories to watch'));
    expect(() => stop()).not.toThrow();
  });

  it('starts, reports running status, writes a daemon PID file, and cleans up', async () => {
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { daemon: true });
    try {
      const status = getWatchStatus();
      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.startedAt).toBeTruthy();
      expect(status.watchPaths).toEqual([
        path.join(tmpDir, 'src'),
        path.join(tmpDir, 'docs'),
      ]);

      const pidFile = path.join(tmpDir, '.docrelay', 'watch.pid');
      expect(status.pidFile).toBe(pidFile);
      expect(fs.readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    } finally {
      stop();
    }

    expect(getWatchStatus().running).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.docrelay', 'watch.pid'))).toBe(false);
  });

  it('marks linked docs stale when a source file is deleted', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'export class Foo {\n  run() { return 1; }\n}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '## Guide\n\nFoo docs.\n', 'utf-8');
    const config = makeConfig(tmpDir);
    await scanProject(new BuiltinExtractor(), db, config, tmpDir, true);

    const sym = db.prepare("SELECT id FROM symbols WHERE name = 'Foo'").get() as { id: string };
    const docId = docSectionId('docs/guide.md', 'Guide');
    upsertDocSection(db, { id: docId, file: 'docs/guide.md', anchor: 'Guide', doc_type: 'standalone', status: 'in_sync' });
    createMapping(db, { symbol_id: sym.id, doc_id: docId, rel_type: 'describes', review_status: 'confirmed' });

    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), config, { debounceMs: 20 });
    try {
      await sleep(500); // let chokidar finish its initial scan and reach ready
      fs.rmSync(path.join(tmpDir, 'src', 'a.ts'));

      await vi.waitFor(() => {
        const row = db.prepare('SELECT status FROM doc_sections WHERE id = ?').get(docId) as { status: string };
        expect(row.status).toBe('stale');
      }, { timeout: 8000, interval: 100 });

      const mapping = db.prepare('SELECT review_status AS rs FROM mappings WHERE symbol_id = ?').get(sym.id) as { rs: string };
      expect(mapping.rs).toBe('auto');
      expect(getWatchStatus().eventsProcessed).toBeGreaterThanOrEqual(1);
    } finally {
      stop();
    }
  }, 15000);

  it('re-scans and picks up a newly added source file after the debounce', async () => {
    const config = makeConfig(tmpDir);
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), config, { debounceMs: 20 });
    try {
      await sleep(500);
      fs.writeFileSync(path.join(tmpDir, 'src', 'b.ts'), 'export class Bar {\n  go() { return 2; }\n}\n', 'utf-8');

      await vi.waitFor(() => {
        const row = db.prepare("SELECT id FROM symbols WHERE name = 'Bar'").get();
        expect(row).toBeTruthy();
      }, { timeout: 8000, interval: 200 });
    } finally {
      stop();
    }
  }, 15000);
});
