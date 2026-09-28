// Deterministic watch.ts event-handler coverage using a mocked chokidar.
// The real-chokidar integration paths live in watch.test.ts; this file drives
// the watcher event handlers (change/debounce/ignore/error/close) directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { startWatch, getWatchStatus } from '../../src/tools/watch.js';
import { BuiltinExtractor } from '../../src/extractors/builtin.js';
import type { SymbolExtractor } from '../../src/extractors/interface.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeWatcher extends EventEmitter {
  async close(): Promise<void> { /* no-op */ }
}

const hoisted = vi.hoisted(() => {
  const state: { watcher: FakeWatcher | undefined; throwOnWatch: Error | undefined } = {
    watcher: undefined,
    throwOnWatch: undefined,
  };
  return { state };
});

vi.mock('chokidar', () => ({
  watch: () => {
    const pending = hoisted.state.throwOnWatch;
    if (pending !== undefined) throw pending;
    return hoisted.state.watcher;
  },
}));

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

describe('startWatch event handlers (mocked chokidar)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-watchev-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    hoisted.state.watcher = new FakeWatcher();
    hoisted.state.throwOnWatch = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses to start a second daemon watcher while the pid file names a live process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      await new Promise<void>((r) => child.once('spawn', () => r()));
      const pidDir = path.join(tmpDir, '.docrelay');
      fs.mkdirSync(pidDir, { recursive: true });
      const pidFile = path.join(pidDir, 'watch.pid');
      fs.writeFileSync(pidFile, String(child.pid));

      const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { daemon: true });
      try {
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
        expect(getWatchStatus().running).toBe(false);
        // The live watcher's pid file must not be clobbered.
        expect(fs.readFileSync(pidFile, 'utf-8')).toBe(String(child.pid));
      } finally {
        stop();
      }
    } finally {
      child.kill();
    }
  });

  it('overwrites a stale pid file left by a crashed watcher', async () => {
    // Deterministically dead pid: spawn a child and wait for it to exit.
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise<void>((r) => child.once('exit', () => r()));
    const pidDir = path.join(tmpDir, '.docrelay');
    fs.mkdirSync(pidDir, { recursive: true });
    const pidFile = path.join(pidDir, 'watch.pid');
    fs.writeFileSync(pidFile, String(child.pid));

    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { daemon: true });
    try {
      expect(getWatchStatus().running).toBe(true);
      expect(fs.readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    } finally {
      stop();
    }
  });

  it('treats a corrupt (non-numeric) pid file as stale and starts', async () => {
    const pidDir = path.join(tmpDir, '.docrelay');
    fs.mkdirSync(pidDir, { recursive: true });
    const pidFile = path.join(pidDir, 'watch.pid');
    fs.writeFileSync(pidFile, 'not-a-pid');

    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { daemon: true });
    try {
      expect(getWatchStatus().running).toBe(true);
      expect(fs.readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    } finally {
      stop();
    }
  });

  it('warns and skips a doc_dir outside the project root', async () => {
    const config = makeConfig(tmpDir, { doc_dirs: ['../outside-docs'] });
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), config);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("doc_dir '../outside-docs' is outside project root"));
    expect(getWatchStatus().watchPaths).toEqual([path.join(tmpDir, 'src')]);
    stop();
  });

  it('skips change events for files matching .docrelayignore', async () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelayignore'), 'src/ignored.ts\n', 'utf-8');
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 20 });
    try {
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'src', 'ignored.ts'));
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'src', 'kept.ts'));

      await vi.waitFor(() => {
        expect(getWatchStatus().eventsProcessed).toBe(1);
      }, { timeout: 2000, interval: 50 });
      await sleep(100);
      // Only the non-ignored file produced a scan.
      expect(getWatchStatus().eventsProcessed).toBe(1);
    } finally {
      stop();
    }
  });

  it('serializes debounced scans from different groups — no concurrent scans', async () => {
    // Two groups' debounce timers can fire while an earlier scan is still
    // running. The watcher must chain scans so a second never enters the
    // extractor before the first finishes (concurrent scans would read the
    // same pre-scan state and duplicate changelog/symbol-created rows).
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
    const order: string[] = [];
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => { gateResolve = r; });
    let extractCalls = 0;
    const gatedExtractor: SymbolExtractor = {
      name: 'builtin',
      isAvailable: async () => true,
      extract: async (dir: string) => {
        extractCalls++;
        const n = extractCalls;
        order.push(`start:${path.basename(dir)}#${n}`);
        if (n === 1) await gate; // hold the FIRST scan inside the extractor
        order.push(`end:#${n}`);
        return [];
      },
    };
    const config = makeConfig(tmpDir, { code_dirs: ['src', 'lib'] });
    const stop = await startWatch(tmpDir, db, gatedExtractor, config, { debounceMs: 10 });
    try {
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'src', 'a.ts'));
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'lib', 'b.ts'));

      // Wait for the first scan to reach the extractor, then let both
      // debounce timers definitely fire (100ms >> debounceMs).
      await vi.waitFor(() => { expect(order.length).toBeGreaterThan(0); }, { timeout: 2000, interval: 20 });
      await sleep(100);
      // While the gate holds, at most ONE scan may be inside extract().
      expect(order.filter((l) => l.startsWith('start')).length).toBe(1);
      expect(order.some((l) => l.startsWith('end'))).toBe(false);

      gateResolve();
      await vi.waitFor(() => { expect(getWatchStatus().eventsProcessed).toBe(2); }, { timeout: 3000, interval: 20 });

      // 2 scans × 2 code_dirs = 4 extract calls, strictly non-overlapping:
      // every 'start' is answered by its 'end' before the next 'start'.
      expect(order).toHaveLength(8);
      for (let i = 0; i < order.length; i += 2) {
        expect(order[i]).toMatch(/^start:/);
        expect(order[i + 1]).toMatch(/^end:/);
      }
    } finally {
      gateResolve();
      stop();
    }
  });

  it('cancels a pending debounce when the same group changes again', async () => {
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 40 });
    try {
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'src', 'a.ts'));
      // Same debounce group (code/src): the pending timer is cancelled and
      // replaced, so only one scan runs even though two events arrived.
      hoisted.state.watcher!.emit('change', path.join(tmpDir, 'src', 'a.ts'));

      await vi.waitFor(() => {
        expect(getWatchStatus().eventsProcessed).toBe(1);
      }, { timeout: 2000, interval: 50 });
      await sleep(150);
      expect(getWatchStatus().eventsProcessed).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('re-scanning symbols'));
    } finally {
      stop();
    }
  });

  it('re-scans docs when a documentation file changes', async () => {
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 20 });
    try {
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'docs', 'guide.md'));

      await vi.waitFor(() => {
        expect(getWatchStatus().eventsProcessed).toBe(1);
      }, { timeout: 2000, interval: 50 });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Doc change'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('new mappings'));
    } finally {
      stop();
    }
  });

  it('records an error and writes a failure marker when the rescan throws', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'x.md'), '## X\n\nbody\n', 'utf-8');
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 20 });
    try {
      db.close(); // any DB use inside the debounced scan now throws
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'docs', 'x.md'));

      await vi.waitFor(() => {
        expect(getWatchStatus().errorsEncountered).toBe(1);
      }, { timeout: 2000, interval: 50 });
      expect(getWatchStatus().lastError).toBeTruthy();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Watch error'));

      const marker = path.join(tmpDir, '.docrelay', 'watch-failed');
      expect(fs.existsSync(marker)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(marker, 'utf-8')) as { error?: string };
      expect(parsed.error).toBeTruthy();
    } finally {
      stop();
    }
  });

  it('records an error when processing a file removal fails', async () => {
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 20 });
    try {
      db.close();
      hoisted.state.watcher!.emit('unlink', path.join(tmpDir, 'src', 'gone.ts'));

      await vi.waitFor(() => {
        expect(getWatchStatus().errorsEncountered).toBe(1);
      }, { timeout: 2000, interval: 50 });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error processing file removal'));
    } finally {
      stop();
    }
  });

  it('records watcher error events in the status', async () => {
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir));
    try {
      hoisted.state.watcher!.emit('error', new Error('boom'));

      expect(getWatchStatus().errorsEncountered).toBe(1);
      expect(getWatchStatus().lastError).toBe('boom');
      expect(errSpy).toHaveBeenCalledWith('Watch error: boom');
    } finally {
      stop();
    }
  });

  it('handles an unexpected watcher close with a crash marker', async () => {
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir));
    hoisted.state.watcher!.emit('close');

    expect(getWatchStatus().running).toBe(false);
    expect(getWatchStatus().lastError).toContain('closed unexpectedly');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('watcher closed unexpectedly'));

    const marker = path.join(tmpDir, '.docrelay', 'watch-crashed');
    expect(fs.existsSync(marker)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf-8')) as { eventsProcessed: number; errorsEncountered: number };
    expect(parsed.eventsProcessed).toBe(0);
    expect(parsed.errorsEncountered).toBe(0);

    expect(() => stop()).not.toThrow();
  });

  it('clears pending debounce timers on stop', async () => {
    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 5000 });
    hoisted.state.watcher!.emit('add', path.join(tmpDir, 'src', 'a.ts'));
    stop();

    await sleep(100);
    expect(getWatchStatus().eventsProcessed).toBe(0);
  });

  it('reports a friendly error when chokidar is not installed', async () => {
    hoisted.state.throwOnWatch = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });

    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir));

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('chokidar is not installed'));
    expect(getWatchStatus().running).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it('reports a generic startup failure', async () => {
    hoisted.state.throwOnWatch = new Error('kaput');

    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir));

    expect(errSpy).toHaveBeenCalledWith('DocRelay watch failed to start:', 'kaput');
    expect(getWatchStatus().lastError).toBe('kaput');
    expect(getWatchStatus().running).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it('delta-filtered doc events still link newly added sections', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'),
      'export function alpha(): number { return 1; }\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'),
      '# Guide\n\n## alpha\n\nUses alpha.\n', 'utf-8');

    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 20 });
    try {
      // Code event: symbol scan sets the last_scan_at watermark and the
      // pipeline ingests guide.md + links alpha to its section.
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'src', 'a.ts'));
      await vi.waitFor(() => {
        const n = db.prepare('SELECT COUNT(*) AS c FROM mappings').get() as { c: number };
        expect(n.c).toBeGreaterThanOrEqual(1);
      }, { timeout: 3000, interval: 50 });

      // Doc event AFTER the watermark exists: the delta filter is active,
      // and the newly appended section must still be ingested and linked.
      fs.appendFileSync(path.join(tmpDir, 'docs', 'guide.md'),
        '\n## alpha usage\n\nMore about alpha.\n', 'utf-8');
      hoisted.state.watcher!.emit('change', path.join(tmpDir, 'docs', 'guide.md'));
      await vi.waitFor(() => {
        const n = db.prepare('SELECT COUNT(DISTINCT doc_id) AS c FROM mappings').get() as { c: number };
        expect(n.c).toBeGreaterThanOrEqual(2);
      }, { timeout: 3000, interval: 50 });

      const sections = db.prepare("SELECT COUNT(*) AS c FROM doc_sections WHERE file = 'docs/guide.md'").get() as { c: number };
      expect(sections.c).toBe(3); // preamble + alpha + alpha usage
    } finally {
      stop();
    }
  });

  it('doc-only events do not move the symbol-scan watermark', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'),
      'export function alpha(): number { return 1; }\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'),
      '# Guide\n\n## alpha\n\nUses alpha.\n', 'utf-8');
    const watermark = () =>
      (db.prepare("SELECT value FROM metadata WHERE key = 'last_scan_at'").get() as { value: string } | undefined)?.value;

    const stop = await startWatch(tmpDir, db, new BuiltinExtractor(), makeConfig(tmpDir), { debounceMs: 20 });
    try {
      hoisted.state.watcher!.emit('add', path.join(tmpDir, 'src', 'a.ts'));
      await vi.waitFor(() => {
        expect(getWatchStatus().eventsProcessed).toBe(1);
        expect(watermark()).toBeTruthy();
      }, { timeout: 3000, interval: 50 });
      await sleep(150); // let the async scan body finish
      const before = watermark();
      expect(before).toBeTruthy();

      // A doc-only event must NOT advance the watermark — otherwise the next
      // incremental symbol scan would skip code files edited since the real
      // symbol scan.
      hoisted.state.watcher!.emit('change', path.join(tmpDir, 'docs', 'guide.md'));
      await vi.waitFor(() => {
        expect(getWatchStatus().eventsProcessed).toBe(2);
      }, { timeout: 3000, interval: 50 });
      await sleep(150);
      expect(watermark()).toBe(before);
    } finally {
      stop();
    }
  });
});
