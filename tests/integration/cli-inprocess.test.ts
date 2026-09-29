/**
 * In-process CLI coverage: cli.ts is a top-level script that registers
 * commander commands and awaits parseAsync(), so each test imports it
 * fresh (query-string cache busting) with argv and DOCRELAY_PROJECT_ROOT
 * set. process.exit is mocked to throw (captured as the exit code), and
 * console/stdout/stderr writes are captured for assertions.
 *
 * The seeded config points codegraph.command at a nonexistent binary so
 * ensureContext falls back to the builtin extractor quickly instead of
 * spawning a real codegraph MCP server per test.
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
import { DOCRELAY_VERSION } from '../../src/version.js';

/* The mcp command boots the server on a mocked stdio transport. */
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

/* restore/reset prompt via readline — answer is controllable per test. */
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cliunit-'));
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
  // Each cli.js import registers a process 'exit' listener.
  process.setMaxListeners(0);
});

afterEach(() => {
  process.argv = savedArgv;
  delete process.env.DOCRELAY_PROJECT_ROOT;
  delete process.env.DOCRELAY_NO_UPDATE_CHECK;
  vi.restoreAllMocks();
  closeAllDbs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runCli(args: string[], opts: { argv1?: string } = {}): Promise<number> {
  process.argv = ['node', opts.argv1 ?? 'docrelay', ...args];
  process.env.DOCRELAY_PROJECT_ROOT = tmpDir;
  // Re-evaluate cli.ts (and its module graph) for every invocation so each
  // command runs against this test's argv/project root. Note: the fresh
  // graph opens its own better-sqlite3 handle to the same db file — seeded
  // rows are visible through WAL, and leftover handles are reaped when the
  // tmpdir is removed.
  vi.resetModules();
  try {
    await import('../../src/cli.js');
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

/** Project on disk: config with an unavailable codegraph + tiny src/docs. */
function seedProject(): void {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), [
    'version: 1',
    'project: cliunit',
    'doc_dirs: [docs, README.md]',
    'code_dirs: [src]',
    'strategies: { inline: auto_update, standalone: auto_update, generated: auto_update, architecture: mark_stale }',
    'codegraph: { command: definitely-missing-binary }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'export function login(user: string): boolean {\n  return user.length > 0;\n}\n');
  fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '# API\n\n## login\n\nAuthenticates via login.\n');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# cliunit\n');
}

/** Database rows for mapping-oriented commands. */
function seedDb(): void {
  const db = getDb(tmpDir);
  runMigrations(db);
  upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
  upsertDocSection(db, { id: docId, file: 'docs/api.md', doc_type: 'standalone' });
}

const out = (): string => logs.join('\n');
const errOut = (): string => errs.join('\n');

describe('CLI in-process: meta and init', () => {
  it('--version prints the package version', async () => {
    expect(await runCli(['--version'])).toBe(0);
    expect(out()).toContain(DOCRELAY_VERSION);
  });

  it('init scaffolds the project without scanning', async () => {
    seedProject();
    expect(await runCli(['init', '--no-hooks', '--no-scan', '--no-integrate'])).toBe(0);
    expect(out()).toContain('.docrelay/config.yaml already exists');
    expect(fs.existsSync(path.join(tmpDir, '.git', 'docrelay.db'))).toBe(true);
  });

  it('reports an unknown command', async () => {
    expect(await runCli(['frobnicate'])).toBe(1);
    expect(errOut()).toContain('frobnicate');
  });
});

describe('CLI in-process: status', () => {
  it('prints the status dashboard as JSON', async () => {
    seedProject();
    expect(await runCli(['status'])).toBe(0);
    const parsed = JSON.parse(logs.find((l) => l.includes('totalSymbols')) ?? '{}') as { totalSymbols: number };
    expect(parsed.totalSymbols).toBe(0);
  });

  it('prints the status dashboard as markdown', async () => {
    seedProject();
    expect(await runCli(['status', '--format', 'markdown'])).toBe(0);
    expect(out()).toContain('## DocRelay Status');
  });
});

describe('CLI in-process: link / confirm / reject / history', () => {
  it('requires --symbol and --doc', async () => {
    seedProject();
    expect(await runCli(['link', 'create'])).toBe(1);
    expect(errOut()).toContain('--symbol <id> is required');
    expect(await runCli(['link', 'create', '--symbol', symId])).toBe(1);
    expect(errOut()).toContain('--doc <id> is required');
  });

  it('rejects an invalid link action', async () => {
    seedProject();
    expect(await runCli(['link', 'frobnicate', '--symbol', symId, '--doc', docId])).toBe(1);
    expect(errOut()).toContain("action must be 'create' or 'delete'");
  });

  it('fails to link endpoints that do not exist', async () => {
    seedProject();
    expect(await runCli(['link', 'create', '--symbol', symId, '--doc', docId])).toBe(1);
    expect(out()).toContain('do not exist');
  });

  it('drives the full link → confirm → reject → history → delete flow', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['link', 'create', '--symbol', symId, '--doc', docId])).toBe(0);
    expect(out()).toContain('"action": "created"');

    expect(await runCli(['confirm', '--symbol', symId, '--doc', docId])).toBe(0);
    expect(out()).toContain('"review_status": "confirmed"');

    expect(await runCli(['reject', '--symbol', symId, '--doc', docId])).toBe(0);
    expect(out()).toContain('"review_status": "rejected"');

    expect(await runCli(['history', '--symbol', symId])).toBe(0);
    expect(out()).toContain('confirmed');
    expect(out()).toContain('rejected');

    expect(await runCli(['link', 'delete', '--symbol', symId, '--doc', docId])).toBe(0);
    expect(out()).toContain('"action": "deleted"');
  });

  it('confirms all unreviewed mappings in bulk', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['confirm', '--all'])).toBe(0);
    expect(out()).toContain('No unreviewed mappings to confirm.');

    const db = getDb(tmpDir);
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(await runCli(['confirm', '--all'])).toBe(0);
    expect(out()).toContain('"confirmed": 1');
  });

  it('rejects a bad history --limit', async () => {
    seedProject();
    expect(await runCli(['history', '--limit', 'zero'])).toBe(1);
    expect(errOut()).toContain('--limit must be a positive integer');
  });

  it('ack transitions a stale doc back to in_sync and reports non-stale docs', async () => {
    seedProject();
    seedDb();
    const db = getDb(tmpDir);
    db.prepare("UPDATE doc_sections SET status = 'stale' WHERE id = ?").run(docId);

    expect(await runCli(['ack', '--doc', docId])).toBe(0);
    expect(out()).toContain('"acknowledged"');
    expect((db.prepare("SELECT status FROM doc_sections WHERE id = ?").get(docId) as { status: string }).status).toBe('in_sync');

    // Second ack is an idempotent no-op reported via notStale.
    expect(await runCli(['ack', '--doc', docId])).toBe(0);
    expect(out()).toContain('"notStale"');
    expect(out()).toContain('in_sync');
  });

  it('ack requires --doc or --all and fails on unknown ids', async () => {
    seedProject();
    expect(await runCli(['ack'])).toBe(1);
    expect(errOut()).toContain('--doc <id> is required');

    seedDb();
    expect(await runCli(['ack', '--doc', docSectionId('docs/ghost.md', 'Nope')])).toBe(1);
    expect(out()).toContain('"notFound"');
  });

  it('ack --all clears every stale section', async () => {
    seedProject();
    seedDb();
    const db = getDb(tmpDir);
    db.prepare("UPDATE doc_sections SET status = 'stale'").run();
    expect(await runCli(['ack', '--all'])).toBe(0);
    expect(out()).toContain('"acknowledged"');
    expect((db.prepare("SELECT COUNT(*) AS n FROM doc_sections WHERE status = 'stale'").get() as { n: number }).n).toBe(0);
  });

  it('reports an unknown symbol in diff', async () => {
    seedProject();
    expect(await runCli(['diff', symId])).toBe(1);
    expect(errOut()).toContain('Symbol not found');
  });
});

describe('CLI in-process: export / gc / config', () => {
  it('exports mappings to .docrelay/mappings.json', async () => {
    seedProject();
    seedDb();
    const db = getDb(tmpDir);
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(await runCli(['export-mappings'])).toBe(0);
    expect(out()).toContain('Exported 1 mappings');
    const exported = JSON.parse(fs.readFileSync(path.join(tmpDir, '.docrelay', 'mappings.json'), 'utf-8')) as unknown[];
    expect(exported).toHaveLength(1);
  });

  it('runs gc against the seeded project', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['gc'])).toBe(0);
  });

  it('gc refuses a collapsed scan and --force overrides the guard', async () => {
    seedProject();
    seedDb();
    // Track far more symbols than the builtin scan of the tiny fixture can
    // re-discover (20 ghosts + login vs 1 found = 95% missing).
    const db = getDb(tmpDir);
    for (let i = 0; i < 20; i++) {
      upsertSymbol(db, { id: `ghost-${i}`, name: `ghost${i}`, kind: 'function' });
    }

    expect(await runCli(['gc'])).toBe(1);
    expect(errOut()).toContain('GC refused');
    expect(errOut()).toContain('--force');
    // Nothing was marked stale (the scan's own 'created' entry for login is fine).
    expect(db.prepare("SELECT COUNT(*) AS c FROM changelog WHERE change_type = 'deleted'").get()).toEqual({ c: 0 });

    expect(await runCli(['gc', '--force'])).toBe(0);
    expect(errOut()).toContain('marked as stale');
    expect((db.prepare("SELECT COUNT(*) AS c FROM changelog WHERE change_type = 'deleted'").get() as { c: number }).c).toBeGreaterThan(0);
  });

  it('shows the resolved config', async () => {
    seedProject();
    expect(await runCli(['config', 'show'])).toBe(0);
    expect(out()).toContain('doc_dirs');
  });

  it('validates the config', async () => {
    seedProject();
    expect(await runCli(['config', 'validate'])).toBe(0);
    expect(out()).toContain('Configuration is valid.');
  });
});

describe('CLI in-process: health / check / impact', () => {
  it('runs the health check in both formats', async () => {
    seedProject();
    seedDb();
    const code = await runCli(['health', '--format', 'json']);
    expect([0, 1]).toContain(code);
    expect(out()).toContain('"checks"');
  });

  it('runs check in every output format with no stale docs', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['check'])).toBe(0);
    expect(out()).toContain('"passed"');
    expect(await runCli(['check', '--strict'])).toBe(0);
    expect(await runCli(['check', '--format', 'markdown'])).toBe(0);
    expect(await runCli(['check', '--format', 'ci'])).toBe(0);
    expect(await runCli(['check', '--format', 'shields'])).toBe(0);
  });

  it('filters check results to a single file', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['check', '--file', 'docs/api.md'])).toBe(0);
    expect(out()).toContain('All documentation in sync.');
  });

  it('reports impact for changed files', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['impact', 'src/auth.ts'])).toBe(0);
    expect(await runCli(['impact', 'src/auth.ts', '--format', 'markdown'])).toBe(0);
  });
});

describe('CLI in-process: sync / hooks / annotate', () => {
  it('requires --symbol or --all-stale for sync', async () => {
    seedProject();
    expect(await runCli(['sync'])).toBe(1);
    expect(errOut()).toContain('--symbol <id> is required');
  });

  it('syncs all stale docs (none) without error', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['sync', '--all-stale'])).toBe(0);
  });

  it('installs git hooks, then refuses to overwrite without --force', async () => {
    seedProject();
    // install-hooks validates the doc-relay binary via argv[1]: the
    // self-reference branch looks for cli.js (which does not exist in the
    // source layout), so use a fake binary under a '/.npm/' path, which the
    // user-install prefix rule accepts.
    const fakeBin = path.join(tmpDir, '.npm', 'bin', 'docrelay');
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await runCli(['install-hooks'], { argv1: fakeBin })).toBe(0);
    expect(out()).toContain('hooks installed successfully');
    // Second run skips existing hooks with a warning instead of failing.
    expect(await runCli(['install-hooks'], { argv1: fakeBin })).toBe(0);
    expect(warns.join('\n')).toContain('already exists — skipping');
    expect(await runCli(['install-hooks', '--force'], { argv1: fakeBin })).toBe(0);
  });

  it('annotates a commit message file within the project', async () => {
    seedProject();
    seedDb();
    fs.writeFileSync(path.join(tmpDir, 'msg.txt'), 'feat: thing\n');
    expect(await runCli(['annotate-commit', 'msg.txt'])).toBe(0);
    const content = fs.readFileSync(path.join(tmpDir, 'msg.txt'), 'utf-8');
    expect(content).toContain('feat: thing');
    expect(content.length).toBeGreaterThan('feat: thing\n'.length);
  });

  it('refuses to annotate a commit message outside the project root', async () => {
    seedProject();
    expect(await runCli(['annotate-commit', '../evil.txt'])).toBe(1);
    expect(errOut()).toContain('must be within project root');
  });
});

describe('CLI in-process: scan / review / integrate', () => {
  it('scans the seeded project', async () => {
    seedProject();
    expect(await runCli(['scan'])).toBe(0);
    expect(errOut()).toContain('Scanning codebase...');
  });

  it('previews a scan with --dry-run', async () => {
    seedProject();
    expect(await runCli(['scan', '--dry-run'])).toBe(0);
    expect(errOut()).toContain('[dry-run]');
  });

  it('scans code only with --no-docs', async () => {
    seedProject();
    expect(await runCli(['scan', '--no-docs'])).toBe(0);
  });

  it('scans incrementally using the previous scan timestamp', async () => {
    seedProject();
    expect(await runCli(['scan'])).toBe(0);
    expect(await runCli(['scan', '--incremental'])).toBe(0);
    expect(errOut()).toContain('Scanning codebase...');
  });

  it('treats a first-time incremental scan as a full scan', async () => {
    seedProject();
    expect(await runCli(['scan', '--incremental'])).toBe(0);
  });

  it('falls back to a full scan when last_scan_at is unparsable', async () => {
    seedProject();
    seedDb();
    const db = getDb(tmpDir);
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_scan_at', 'not-a-date')").run();
    expect(await runCli(['scan', '--incremental'])).toBe(0);
  });

  it('renders the review report in markdown and json', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['review'])).toBe(0);
    expect(out()).toContain('## DocRelay Review');
    expect(await runCli(['review', '--json'])).toBe(0);
  });

  it('lists agents, rejects unknown agents, and dry-runs a known one', async () => {
    seedProject();
    expect(await runCli(['integrate', '--list'])).toBe(0);
    expect(await runCli(['integrate', '--agent', 'bogus'])).toBe(1);
    expect(errOut()).toContain("Unknown agent 'bogus'");
    expect(await runCli(['integrate', '--agent', 'claude-code', '--dry-run'])).toBe(0);
    expect(errOut()).toContain('Dry run');
  });
});

describe('CLI in-process: backup / restore / reset / update', () => {
  it('backs up and restores the database', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['backup'])).toBe(0);
    expect(out()).toContain('Backed up to');
    const backupFile = logs.find((l) => l.includes('Backed up to'))?.replace('Backed up to ', '').trim();
    expect(backupFile).toBeTruthy();
    expect(await runCli(['restore', backupFile ?? '', '--force'])).toBe(0);
  });

  it('rejects a backup output outside the project root', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['backup', '--output', '../evil.db'])).toBe(1);
    expect(errOut()).toContain('within project root');
  });

  it('rejects a negative --keep', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['backup', '--keep', '-1'])).toBe(1);
    expect(errOut()).toContain('--keep must be a non-negative integer');
  });

  it('rejects restore paths outside the root, missing files, and non-.db files', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['restore', '../evil.db', '--force'])).toBe(1);
    expect(errOut()).toContain('must be within project root');
    expect(await runCli(['restore', 'missing.db', '--force'])).toBe(1);
    expect(errOut()).toContain('Backup file not found');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'x');
    expect(await runCli(['restore', 'notes.txt', '--force'])).toBe(1);
    expect(errOut()).toContain('.db extension');
  });

  it('resets the database with --force', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['reset', '--force'])).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.git', 'docrelay.db'))).toBe(true);
  });

  it('aborts update on a non-default npm registry', async () => {
    seedProject();
    process.env.npm_config_registry = 'http://evil-registry.example.com/';
    try {
      expect(await runCli(['update'])).toBe(1);
      expect(errOut()).toContain('Security warning');
    } finally {
      delete process.env.npm_config_registry;
    }
  });

  it('reports a missing which utility during update', async () => {
    seedProject();
    const savedPath = process.env.PATH;
    // Empty PATH: `which` itself cannot be spawned → ENOENT branch.
    process.env.PATH = tmpDir;
    try {
      expect(await runCli(['update'])).toBe(1);
      expect(errOut()).toContain('Cannot locate npm');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  /** Fake `which` + `npm` pair for update-gate tests; returns a bin dir for PATH. */
  function seedFakeWhichNpm(fakeNpmPath: string): string {
    const binDir = path.join(tmpDir, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'which'), [
      '#!/bin/sh',
      "if [ \"$1\" = \"npm\" ]; then printf '%s\\n' \"$FAKE_NPM\"; exit 0; fi",
      'exit 1',
      '',
    ].join('\n'));
    fs.writeFileSync(fakeNpmPath, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi',
      'if [ "$1" = "config" ]; then echo "https://registry.npmjs.org/"; exit 0; fi',
      'if [ "$1" = "install" ]; then echo "simulated install failure" >&2; exit 1; fi',
      'exit 1',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(binDir, 'which'), 0o755);
    fs.chmodSync(fakeNpmPath, 0o755);
    return binDir;
  }

  it('rejects a version-manager npm outside the home directory', async () => {
    seedProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-outside-'));
    const fakeNpm = path.join(outside, '.nvm', 'bin', 'npm');
    fs.mkdirSync(path.dirname(fakeNpm), { recursive: true });
    const binDir = seedFakeWhichNpm(fakeNpm);
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_NPM: process.env.FAKE_NPM };
    // HOME is tmpDir; the fake npm lives under a different tmp root, so the
    // `/.nvm/` token matches but the home-anchor must reject it.
    process.env.HOME = tmpDir;
    process.env.PATH = binDir;
    process.env.FAKE_NPM = fakeNpm;
    try {
      expect(await runCli(['update'])).toBe(1);
      expect(errOut()).toContain('Security warning');
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      delete process.env.FAKE_NPM;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts a version-manager npm inside the home directory', async () => {
    seedProject();
    const fakeNpm = path.join(tmpDir, '.volta', 'bin', 'npm');
    fs.mkdirSync(path.dirname(fakeNpm), { recursive: true });
    const binDir = seedFakeWhichNpm(fakeNpm);
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_NPM: process.env.FAKE_NPM };
    process.env.HOME = tmpDir;
    process.env.PATH = binDir;
    process.env.FAKE_NPM = fakeNpm;
    try {
      // Gate passes; the fake npm then fails the install step on purpose.
      expect(await runCli(['update'])).toBe(1);
      expect(errOut()).toContain('Update failed');
      expect(errOut()).toContain('npm install -g doc-relay@latest');
      expect(errOut()).not.toContain('Security warning');
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      delete process.env.FAKE_NPM;
    }
  });

  it('update does not require an initialized project', async () => {
    // No seedProject(): update wraps npm and touches nothing project-local,
    // so the project gate must not fire — an empty PATH drives it to the
    // npm-resolution branch instead of "Not initialized".
    const savedPath = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      expect(await runCli(['update'])).toBe(1);
      expect(errOut()).toContain('Cannot locate npm');
      expect(errOut()).not.toContain('Not initialized');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('CLI in-process: diff and history formats', () => {
  it('shows the diff report for a known symbol', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['diff', symId])).toBe(0);
    expect(await runCli(['diff', symId, '--format', 'markdown'])).toBe(0);
  });

  it('diff resolves a unique bare symbol name', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['diff', 'login'])).toBe(0);
    expect(out()).toContain(symId);
  });

  it('diff rejects an ambiguous bare name with candidates', async () => {
    seedProject();
    seedDb();
    const otherId = symbolId('ts', 'src/other.ts::login', 'function');
    upsertSymbol(getDb(tmpDir), {
      id: otherId, name: 'login', kind: 'function',
      location: 'src/other.ts:3', signature: 'function login(): void', raw_signature: '',
    });
    expect(await runCli(['diff', 'login'])).toBe(1);
    expect(errOut()).toContain('matches 2 symbols');
    expect(errOut()).toContain(otherId);
  });

  it('renders history as markdown', async () => {
    seedProject();
    seedDb();
    const db = getDb(tmpDir);
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(await runCli(['confirm', '--symbol', symId, '--doc', docId])).toBe(0);
    expect(await runCli(['history', '--format', 'markdown'])).toBe(0);
  });

  it('shows the config via the default config action', async () => {
    seedProject();
    expect(await runCli(['config'])).toBe(0);
    expect(out()).toContain('doc_dirs');
  });
});

describe('CLI in-process: top-level crash safety net', () => {
  afterEach(() => {
    delete process.env.DOCRELAY_DEBUG;
    vi.doUnmock('../../src/index.js');
  });

  it('an unexpected command crash surfaces one clean line and exit 1 — no stack dump', async () => {
    // The mcp action awaits index.js main(); make it reject to simulate an
    // unexpected failure escaping every command-local try/catch.
    vi.doMock('../../src/index.js', () => ({
      main: () => Promise.reject(new Error('kaboom from index')),
    }));
    seedProject();

    expect(await runCli(['mcp'])).toBe(1);
    const errText = errOut();
    expect(errText).toContain('DocRelay: unexpected error: kaboom from index');
    // Node's default unhandled-rejection surface (stack frames, Node version
    // footer) must not leak into the user's terminal.
    expect(errText).not.toMatch(/at Object\.|at async |node:internal/);
  });

  it('prints the crash stack only when DOCRELAY_DEBUG is set', async () => {
    process.env.DOCRELAY_DEBUG = '1';
    vi.doMock('../../src/index.js', () => ({
      main: () => Promise.reject(new Error('kaboom from index')),
    }));
    seedProject();

    expect(await runCli(['mcp'])).toBe(1);
    const errText = errOut();
    expect(errText).toContain('DocRelay: unexpected error: kaboom from index');
    expect(errText).toContain('(debug stack):');
  });

  it('an intentional command failure still exits with its own code (not reclassified)', async () => {
    // status in an uninitialized project exits 1 via requireProject — the
    // safety net must not turn intentional exits into "unexpected error".
    expect(await runCli(['status'])).toBe(1);
    expect(errOut()).toContain('Not initialized');
    expect(errOut()).not.toContain('unexpected error');
  });

  it('check infrastructure errors exit 2 (distinct from 1 = stale docs)', async () => {
    // Force docrelayCheck to report an infrastructure error — the CLI must
    // exit 2 so the git hooks print infra guidance, not the stale message.
    vi.doMock('../../src/tools/check.js', async (importOriginal) => {
      const mod = await importOriginal<typeof import('../../src/tools/check.js')>();
      return {
        ...mod,
        docrelayCheck: () => ({
          passed: false,
          staleDocs: [],
          summary: 'Database error: check server logs for details.',
          error: 'Database query error — check server logs for details',
        }),
      };
    });
    try {
      seedProject();
      expect(await runCli(['check', '--strict'])).toBe(2);
      expect(errOut()).toContain('DocRelay check failed');
      expect(errOut()).not.toContain('unexpected error');
    } finally {
      vi.doUnmock('../../src/tools/check.js');
    }
  });

  it('check exits 2 when the database cannot even be opened (corrupt file)', async () => {
    // A corrupt DB fails inside ensureContext (getDb/runMigrations), before
    // docrelayCheck runs — the hooks still need exit 2, not the stale
    // message. Write a file SQLite rejects at the header.
    seedProject();
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'docrelay.db'),
      'NOT A SQLITE DATABASE — header magic intentionally broken for the test',
    );
    expect(await runCli(['check', '--strict'])).toBe(2);
    expect(errOut()).toContain('DocRelay initialization failed');
    expect(errOut()).not.toContain('unexpected error');
  });

  it('other commands keep exit 1 on initialization failure', async () => {
    seedProject();
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'docrelay.db'),
      'NOT A SQLITE DATABASE — header magic intentionally broken for the test',
    );
    expect(await runCli(['status'])).toBe(1);
    expect(errOut()).toContain('DocRelay initialization failed');
  });

  it('commander usage errors keep their own exit code and message', async () => {
    seedProject();
    expect(await runCli(['status', '--bogus-flag'])).toBe(1);
    const errText = errOut();
    expect(errText).toContain("unknown option '--bogus-flag'");
    expect(errText).not.toContain('unexpected error');
  });

  it('--help exits 0 and prints usage', async () => {
    expect(await runCli(['--help'])).toBe(0);
    expect(out()).toContain('Usage: docrelay');
  });
});

describe('CLI in-process: mcp / restore prompts / integrate dry-run', () => {
  it('mcp boots the server on the mocked stdio transport', async () => {
    seedProject();
    expect(await runCli(['mcp'])).toBe(0);
    expect(errOut()).toContain('DocRelay MCP Server running on stdio');
  });

  it('restore cancels when the confirmation is not "yes"', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['backup'])).toBe(0);
    const backupFile = logs.find((l) => l.includes('Backed up to'))?.replace('Backed up to ', '').trim();
    rlAnswer.current = 'no';
    await runCli(['restore', backupFile ?? '']);
    // The harness's mocked process.exit(0) throws, and the command's own
    // catch converts that to a failure exit — so the exit code is not
    // meaningful here. What matters: the prompt ran and nothing restored.
    expect(errOut()).toContain('Restore cancelled.');
    expect(out()).not.toContain('Restored');
  });

  it('restore proceeds when the confirmation is "yes"', async () => {
    seedProject();
    seedDb();
    expect(await runCli(['backup'])).toBe(0);
    const backupFile = logs.find((l) => l.includes('Backed up to'))?.replace('Backed up to ', '').trim();
    rlAnswer.current = 'yes';
    expect(await runCli(['restore', backupFile ?? ''])).toBe(0);
  });

  it('dry-run integrate reports an already-configured agent (opencode)', async () => {
    seedProject();
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Rules\n\n## DocRelay — Code-Documentation Sync\n\nconfigured\n');
    fs.writeFileSync(path.join(tmpDir, 'opencode.json'), JSON.stringify({ mcp: { docrelay: { type: 'local', command: ['doc-relay', 'mcp'], enabled: true } } }));
    expect(await runCli(['integrate', '--agent', 'opencode', '--dry-run'])).toBe(0);
    expect(out()).toContain('No changes needed');
  });

  it('dry-run integrate reports an already-configured agent (cursor)', async () => {
    seedProject();
    fs.mkdirSync(path.join(tmpDir, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { docrelay: { command: 'doc-relay', args: ['mcp'] } } }));
    expect(await runCli(['integrate', '--agent', 'cursor', '--dry-run'])).toBe(0);
    // .mcp.json is already configured — it must not be listed as a change.
    expect(out()).not.toContain('.mcp.json');
  });
});
