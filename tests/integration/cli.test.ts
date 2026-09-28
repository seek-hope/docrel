/**
 * End-to-end CLI smoke tests: run the real dist/cli.js binary in a throwaway
 * project and verify exit codes and output of the main user-facing commands.
 * These tests exercise the commander wiring, project guards, and JSON output
 * that unit tests cannot reach (cli.ts itself is process-level code).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLI = path.join(process.cwd(), 'dist', 'cli.js');
const require = createRequire(path.join(process.cwd(), 'package.json'));

interface RunResult { code: number | null; stdout: string; stderr: string }

function run(args: string[], cwd: string): RunResult {
  const r = spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, DOCRELAY_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    const build = spawnSync('npm', ['run', 'build'], { cwd: process.cwd(), encoding: 'utf-8' });
    if (build.status !== 0) throw new Error(`npm run build failed:\n${build.stderr}`);
  }
}, 180_000);

describe('CLI smoke', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cli-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'auth.ts'),
      'export function login(user: string, pass: string): boolean {\n  return user.length > 0 && pass.length > 0;\n}\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'api.md'),
      '# API\n\n## login\n\nAuthenticates a user via login.\n',
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--version prints the package version', () => {
    const r = run(['--version'], tmpDir);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--help lists the main commands', () => {
    const r = run(['--help'], tmpDir);
    expect(r.code).toBe(0);
    for (const cmd of ['init', 'scan', 'status', 'check', 'review', 'mcp']) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it('status exits 1 with guidance outside an initialized project', () => {
    const r = run(['status'], tmpDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('doc-relay init');
  });

  it('init scaffolds .docrelay/ and a valid config', () => {
    const r = run(['init', '--no-hooks', '--no-scan', '--no-integrate'], tmpDir);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.docrelay', 'config.yaml'))).toBe(true);

    const show = run(['config', 'show'], tmpDir);
    expect(show.code).toBe(0);
    const validate = run(['config', 'validate'], tmpDir);
    expect(validate.code).toBe(0);
  });

  it('full flow: init → scan → status → check → review → backup → gc', { timeout: 120_000 }, () => {
    expect(run(['init', '--no-hooks', '--no-scan', '--no-integrate'], tmpDir).code).toBe(0);

    const scan = run(['scan'], tmpDir);
    expect(scan.code).toBe(0);
    const scanReport = JSON.parse(scan.stdout) as { symbols: { totalSymbols: number } };
    expect(scanReport.symbols.totalSymbols).toBeGreaterThanOrEqual(1);

    const status = run(['status', '--format', 'json'], tmpDir);
    expect(status.code).toBe(0);
    const parsed = JSON.parse(status.stdout) as { totalSymbols: number; totalDocs: number };
    expect(parsed.totalSymbols).toBeGreaterThanOrEqual(1);
    expect(parsed.totalDocs).toBeGreaterThanOrEqual(1);

    const statusMd = run(['status', '--format', 'markdown'], tmpDir);
    expect(statusMd.code).toBe(0);
    expect(statusMd.stdout).toContain('## DocRelay Status');

    const check = run(['check', '--strict'], tmpDir);
    expect(check.code).toBe(0);

    const review = run(['review', '--format', 'json'], tmpDir);
    expect(review.code).toBe(0);
    expect(JSON.parse(review.stdout)).toHaveProperty('summary');

    const backup = run(['backup'], tmpDir);
    expect(backup.code).toBe(0);
    const backups = fs.readdirSync(path.join(tmpDir, '.docrelay')).filter((f) => f.startsWith('backup-'));
    expect(backups.length).toBe(1);

    const gc = run(['gc'], tmpDir);
    expect(gc.code).toBe(0);
  });

  it('check --strict exits 1 when docs are stale and --file filters correctly', { timeout: 120_000 }, () => {
    expect(run(['init', '--no-hooks', '--no-scan', '--no-integrate'], tmpDir).code).toBe(0);
    expect(run(['scan'], tmpDir).code).toBe(0);

    // Flip every doc section to stale directly in the DB (no CLI command
    // marks docs stale on demand; scan-driven staleness is covered elsewhere).
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(path.join(tmpDir, '.git', 'docrelay.db'));
    db.prepare("UPDATE doc_sections SET status = 'stale'").run();
    db.close();

    const strict = run(['check', '--strict'], tmpDir);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain('docs/api.md');

    const filtered = run(['check', '--strict', '--file', 'docs/api.md'], tmpDir);
    expect(filtered.code).toBe(1);

    const filteredMiss = run(['check', '--strict', '--file', 'docs/other.md'], tmpDir);
    expect(filteredMiss.code).toBe(0);

    // Non-strict check reports but does not fail.
    const soft = run(['check'], tmpDir);
    expect(soft.code).toBe(0);
  });

  it('export-mappings writes a JSON mappings file', { timeout: 120_000 }, () => {
    expect(run(['init', '--no-hooks', '--no-scan', '--no-integrate'], tmpDir).code).toBe(0);
    expect(run(['scan'], tmpDir).code).toBe(0);

    const r = run(['export-mappings'], tmpDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Exported');
    const outFile = path.join(tmpDir, '.docrelay', 'mappings.json');
    expect(Array.isArray(JSON.parse(fs.readFileSync(outFile, 'utf-8')))).toBe(true);
  });

  it('health reports project state', () => {
    expect(run(['init', '--no-hooks', '--no-scan', '--no-integrate'], tmpDir).code).toBe(0);
    const r = run(['health'], tmpDir);
    expect(r.code).toBe(0);
  });

  it('scan --dry-run writes nothing to the database', { timeout: 120_000 }, () => {
    expect(run(['init', '--no-hooks', '--no-scan', '--no-integrate'], tmpDir).code).toBe(0);

    const dry = run(['scan', '--dry-run'], tmpDir);
    expect(dry.code).toBe(0);

    const status = run(['status', '--format', 'json'], tmpDir);
    const parsed = JSON.parse(status.stdout) as { totalSymbols: number };
    expect(parsed.totalSymbols).toBe(0);
  });
});
