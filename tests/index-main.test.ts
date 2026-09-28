/**
 * Process-bootstrap coverage for index.ts main(): server startup on a
 * mocked stdio transport, signal-handler shutdown semantics (exit-code
 * escalation across concurrent signals/crashes), and initDeps failure
 * paths. Handlers are invoked directly (diffed from pre-registered
 * listeners) so vitest's own signal handling is never triggered, and the
 * 500ms force-exit timer is neutralized with fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeAllDbs } from '../src/db/connection.js';
import { fileURLToPath } from 'node:url';

class ExitSignal extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    onmessage: unknown;
    onclose: unknown;
    onerror: unknown;
    async start(): Promise<void> { /* no real stdio */ }
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

let tmpDir: string;
let errs: string[];
const savedArgv = [...process.argv];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-idxmain-'));
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), [
    'version: 1',
    'project: idxmain',
    'doc_dirs: [docs]',
    'code_dirs: [src]',
    'codegraph: { command: definitely-missing-binary }',
    '',
  ].join('\n'));
  errs = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code ?? 0); }) as never);
  process.env.DOCRELAY_PROJECT_ROOT = tmpDir;
  process.env.DOCRELAY_NO_UPDATE_CHECK = '1';
  process.setMaxListeners(0);
});

afterEach(() => {
  process.argv = savedArgv;
  delete process.env.DOCRELAY_PROJECT_ROOT;
  delete process.env.DOCRELAY_NO_UPDATE_CHECK;
  delete process.env.DOCRELAY_DEBUG;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  closeAllDbs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function importIndex(): Promise<typeof import('../src/index.js')> {
  vi.resetModules();
  return await import('../src/index.js');
}

type Handler = (...args: any[]) => void;

const listenersOf = (event: string): Handler[] =>
  process.listeners(event as never) as Handler[];

/** Diff process listeners registered after main() ran. */
function newListener(event: string, before: Handler[]): Handler | undefined {
  return listenersOf(event).find((l) => !before.includes(l));
}

/** Invoke a shutdown handler and flush its async work while the 500ms
 *  force-exit timer stays frozen on the fake clock. */
async function fire(handler: Handler, ...args: unknown[]): Promise<void> {
  vi.useFakeTimers();
  try {
    handler(...args);
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
}

describe('index main() process wiring', () => {
  it('starts the server on stdio and shuts down cleanly on SIGINT', async () => {
    const idx = await importIndex();
    const sigintBefore = listenersOf('SIGINT');
    await idx.main();
    expect(errs.join('\n')).toContain('DocRelay MCP Server running on stdio');

    const sigint = newListener('SIGINT', sigintBefore);
    expect(sigint).toBeDefined();
    await fire(sigint!);
    expect(errs.join('\n')).toContain('shutting down');
    expect(process.exitCode).toBe(0);
  });

  it('escalates to exit code 1 when a crash follows a clean signal', async () => {
    const idx = await importIndex();
    const sigintBefore = listenersOf('SIGINT');
    const crashBefore = listenersOf('uncaughtException');
    await idx.main();

    await fire(newListener('SIGINT', sigintBefore)!);
    expect(process.exitCode).toBe(0);
    await fire(newListener('uncaughtException', crashBefore)!, new Error('boom'));
    expect(process.exitCode).toBe(1);
  });

  it('keeps exit code 1 when a clean signal follows a crash', async () => {
    const idx = await importIndex();
    const sigintBefore = listenersOf('SIGINT');
    const crashBefore = listenersOf('uncaughtException');
    await idx.main();

    await fire(newListener('uncaughtException', crashBefore)!, new Error('boom'));
    expect(process.exitCode).toBe(1);
    await fire(newListener('SIGINT', sigintBefore)!);
    expect(process.exitCode).toBe(1);
  });

  it('shuts down with code 1 on an unhandled rejection', async () => {
    const idx = await importIndex();
    const rejBefore = listenersOf('unhandledRejection');
    await idx.main();

    await fire(newListener('unhandledRejection', rejBefore)!, new Error('async boom'));
    expect(process.exitCode).toBe(1);
  });

  it('exits when DOCRELAY_PROJECT_ROOT is unset and no config exists in CWD', async () => {
    delete process.env.DOCRELAY_PROJECT_ROOT;
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-idxbare-'));
    const cwd = process.cwd();
    process.chdir(bare);
    try {
      const idx = await importIndex();
      await expect(idx.main()).rejects.toThrow('process.exit(1)');
      expect(errs.join('\n')).toContain('DOCRELAY_PROJECT_ROOT not set');
    } finally {
      process.chdir(cwd);
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('exits when the database cannot be initialized', async () => {
    // A directory where the database file should be makes better-sqlite3 fail.
    fs.mkdirSync(path.join(tmpDir, '.git', 'docrelay.db'), { recursive: true });
    const idx = await importIndex();
    await expect(idx.main()).rejects.toThrow('process.exit(1)');
    expect(errs.join('\n')).toContain('Failed to initialize DocRelay');
  });
});

describe('index auto-start (invoked directly)', () => {
  const selfIndex = fileURLToPath(new URL('../src/index.ts', import.meta.url));

  it('starts main() automatically when executed directly', async () => {
    process.argv[1] = selfIndex;
    await importIndex();
    await vi.waitFor(() => {
      expect(errs.join('\n')).toContain('DocRelay MCP Server running on stdio');
    }, { timeout: 5000 });
  });

  it('reports a fatal error and sets exit code 1 when auto-start fails', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'docrelay.db'), { recursive: true });
    process.argv[1] = selfIndex;
    await importIndex();
    await vi.waitFor(() => {
      expect(errs.join('\n')).toContain('Fatal error:');
    }, { timeout: 5000 });
    expect(process.exitCode).toBe(1);
  });
});

describe('index main() debug logging', () => {
  it('logs the rejection stack when DOCRELAY_DEBUG is set', async () => {
    process.env.DOCRELAY_DEBUG = '1';
    const idx = await importIndex();
    const rejBefore = listenersOf('unhandledRejection');
    await idx.main();
    await fire(newListener('unhandledRejection', rejBefore)!, new Error('async boom'));
    expect(errs.join('\n')).toContain('debug stack');
    expect(process.exitCode).toBe(1);
  });
});
