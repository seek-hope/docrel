// Deterministic watch.ts event-handler coverage using a mocked chokidar.
// The real-chokidar integration paths live in watch.test.ts; this file drives
// the watcher event handlers (change/debounce/ignore/error/close) directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { startWatch, getWatchStatus } from '../../src/tools/watch.js';
import { BuiltinExtractor } from '../../src/extractors/builtin.js';
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
});
