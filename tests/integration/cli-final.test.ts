/**
 * Final in-process CLI coverage batch: the remaining reachable gaps in
 * cli.ts — reject --all, annotate-commit edge cases (oversize, stat
 * failure, hook already installed), a real (non-dry-run) integrate, the
 * reset confirmation prompt, review --cleanup, and a fault-injected link
 * failure. Conventions mirror cli-inprocess.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';

/* Fault injection for the link failure test: wrap getDb so prepare() on the
   mappings INSERT throws once the flag is set. */
const fault = vi.hoisted(() => ({ current: false }));
vi.mock('../../src/db/connection.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/db/connection.js')>();
  return {
    ...actual,
    getDb: (...args: Parameters<typeof actual.getDb>) => {
      const db = actual.getDb(...args);
      if (!fault.current) return db;
      return new Proxy(db, {
        get(t, p) {
          if (p === 'prepare') {
            return (sql: string) => {
              if (sql.includes('INSERT INTO mappings')) {
                return {
                  get: () => {
                    throw new Error('boom');
                  },
                };
              }
              return t.prepare(sql);
            };
          }
          return Reflect.get(t, p);
        },
      });
    },
  };
});

/* reset prompt via readline — answer is controllable per test. */
const rlAnswer = vi.hoisted(() => ({ current: 'no' }));
vi.mock('node:readline', () => {
  const createInterface = () => ({
    question: (_q: string, cb: (a: string) => void) => cb(rlAnswer.current),
    close: () => {},
  });
  return { default: { createInterface }, createInterface };
});

class ExitSignal extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

let tmpDir: string;
let logs: string[];
let errs: string[];
let warns: string[];
const savedArgv = process.argv;

const symId = symbolId('ts', 'src/auth.ts::login', 'function');
const docId = docSectionId('docs/api.md', 'login');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-clifinal-'));
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  logs = [];
  errs = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { logs.push(String(chunk)); return true; }));
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { errs.push(String(chunk)); return true; }));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code ?? 0); }) as never);
  process.env.DOCRELAY_NO_UPDATE_CHECK = '1';
  process.setMaxListeners(0);
});

afterEach(() => {
  process.argv = savedArgv;
  delete process.env.DOCRELAY_PROJECT_ROOT;
  delete process.env.DOCRELAY_NO_UPDATE_CHECK;
  vi.restoreAllMocks();
  fault.current = false;
  closeAllDbs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runCli(args: string[], opts: { argv1?: string } = {}): Promise<number> {
  process.argv = ['node', opts.argv1 ?? 'docrelay', ...args];
  process.env.DOCRELAY_PROJECT_ROOT = tmpDir;
  vi.resetModules();
  try {
    await import('../../src/cli.js');
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

function seedProject(): void {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), [
    'version: 1',
    'project: clifinal',
    'doc_dirs: [docs, README.md]',
    'code_dirs: [src]',
    'codegraph: { command: definitely-missing-binary }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'export function login(user: string): boolean {\n  return user.length > 0;\n}\n');
  fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '# API\n\n## login\n\nAuthenticates via login.\n');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# clifinal\n');
}

function seedDb(): void {
  const db = getDb(tmpDir);
  runMigrations(db);
  upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
  upsertDocSection(db, { id: docId, file: 'docs/api.md', doc_type: 'standalone' });
}

const out = (): string => logs.join('\n');
const errOut = (): string => errs.join('\n');

describe('CLI final: reject --all', () => {
  it('rejects all unreviewed mappings in bulk and reports the empty case', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['reject', '--all'])).toBe(0);
    expect(out()).toContain('No unreviewed mappings to reject.');

    const db = getDb(tmpDir);
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(await runCli(['reject', '--all'])).toBe(0);
    expect(out()).toContain('"rejected": 1');
  });
});

describe('CLI final: annotate-commit edges', () => {
  it('skips annotation when the message file exceeds 1 MB without blocking the commit', async () => {
    seedProject();
    seedDb();
    const msgFile = path.join(tmpDir, 'msg.txt');
    fs.writeFileSync(msgFile, 'x'.repeat(1_048_577));
    expect(await runCli(['annotate-commit', 'msg.txt'])).toBe(0);
    expect(errOut()).toContain('exceeds 1048576 bytes');
    expect(fs.readFileSync(msgFile, 'utf-8')).toHaveLength(1_048_577);
  });

  it('fails when the message file cannot be stat-ed (EACCES)', async () => {
    seedProject();
    seedDb();
    const msgFile = path.join(tmpDir, 'msg.txt');
    fs.writeFileSync(msgFile, 'feat: subject');
    const realStat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === msgFile) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realStat(p);
    }));
    expect(await runCli(['annotate-commit', 'msg.txt'])).toBe(1);
    expect(errOut()).toContain('Failed to annotate commit message');
  });

  it('reports already installed when the hook symlink points at this CLI', async () => {
    seedProject();
    seedDb();
    const binDir = path.join(tmpDir, '.npm', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeBin = path.join(binDir, 'docrelay');
    fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeBin, 0o755);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.symlinkSync(fakeBin, hookPath);
    const code = await runCli(['install-hooks'], { argv1: fakeBin });
    expect(code, errOut()).toBe(0);
    expect(warns.join('\n')).toContain('hook already exists');
  });
});

describe('CLI final: integrate (real run)', () => {
  it('adds the claude-code integration files', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['integrate', '--agent', 'claude-code'])).toBe(0);
    expect(out()).toContain('integration added');
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(true);
  });
});

describe('CLI final: reset prompt', () => {
  it('cancels when the user does not type yes', async () => {
    seedProject();
    seedDb();
    rlAnswer.current = 'no';
    // Harness artifact: the mocked process.exit(0) throws inside the
    // command's own try/catch and is converted to a failure exit — assert
    // the cancellation message, and that the db file survives.
    await runCli(['reset']);
    expect(errOut()).toContain('Reset cancelled.');
    expect(fs.existsSync(path.join(tmpDir, '.git', 'docrelay.db'))).toBe(true);
  });

  it('deletes and re-initializes the database when the user confirms', async () => {
    seedProject();
    seedDb();
    rlAnswer.current = 'yes';
    expect(await runCli(['reset'])).toBe(0);
    expect(errOut()).toContain('DocRelay database has been reset and re-initialized.');
    expect(fs.existsSync(path.join(tmpDir, '.git', 'docrelay.db'))).toBe(true);
  });
});

describe('CLI final: review --cleanup', () => {
  it('runs the cleanup report', async () => {
    seedProject();
    seedDb();
    const db = getDb(tmpDir);
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    // Harness artifact: the command ends with exit(0) inside its own
    // try/catch, which the mocked process.exit converts to a failure exit —
    // assert the report output instead of the code.
    await runCli(['review', '--cleanup']);
    expect(out()).toContain('## DocRelay Review — Cleanup');
    expect(out()).toContain('Removed');
  });
});

describe('CLI final: link failure', () => {
  it('reports failure when the mapping insert throws', async () => {
    seedProject();
    seedDb();
    fault.current = true;
    const code = await runCli(['link', 'create', '--symbol', symId, '--doc', docId]);
    expect(code).toBe(1);
    expect(errOut()).toContain('Link failed');
  });
});
