#!/usr/bin/env node
/**
 * DocRelay performance benchmark.
 *
 * Generates a synthetic mid-size repository (default 500 TS files x 8
 * exported functions = 4000 symbols, 50 markdown docs x 10 sections) and
 * times the real CLI path: init+full scan, no-op incremental scan, 5%-
 * changed incremental scan, status, and check. Results print as a table;
 * `--json` emits machine-readable output for trending.
 *
 * Usage: node scripts/bench.mjs [--files N] [--docs N] [--json] [--keep]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const FILES = opt('--files', 500);
const DOCS = opt('--docs', 50);
const FUNCS_PER_FILE = 8;
const SECTIONS_PER_DOC = 10;
const AS_JSON = args.includes('--json');
const KEEP = args.includes('--keep');

const CLI = path.resolve(import.meta.dirname, '../dist/cli.js');
if (!fs.existsSync(CLI)) {
  console.error('dist/cli.js not found — run npm run build first.');
  process.exit(1);
}

function genProject(root) {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.docrelay'), { recursive: true });
  fs.writeFileSync(path.join(root, '.docrelay', 'config.yaml'), [
    'version: 1',
    'project: bench',
    'doc_dirs: [docs]',
    'code_dirs: [src]',
    'codegraph: { command: definitely-missing-binary }',
    '',
  ].join('\n'));

  for (let f = 0; f < FILES; f++) {
    const parts = [`/** Module ${f} overview. */`];
    for (let k = 0; k < FUNCS_PER_FILE; k++) {
      const name = `fn${f}x${k}`;
      parts.push(
        `/**`,
        ` * Computes result ${k} for module ${f}.`,
        ` * @param value input number`,
        ` * @returns derived number`,
        ` */`,
        `export function ${name}(value: number): number {`,
        `  return value * ${k + 1} + ${f};`,
        `}`,
        '',
      );
    }
    fs.writeFileSync(path.join(root, 'src', `mod${f}.ts`), parts.join('\n'));
  }

  for (let d = 0; d < DOCS; d++) {
    const parts = [`# Doc ${d}`, ''];
    for (let s = 0; s < SECTIONS_PER_DOC; s++) {
      // Reference a deterministic subset of symbols so auto-link has work.
      const ref = `fn${(d * SECTIONS_PER_DOC + s) % FILES}x${s % FUNCS_PER_FILE}`;
      parts.push(`## Section ${s}`, '', `Documents \`${ref}\` and its behaviour in module ${d}.`, '');
    }
    fs.writeFileSync(path.join(root, 'docs', `doc${d}.md`), parts.join('\n'));
  }

  // Age all generated files to 60s in the past. The incremental-scan cutoff
  // (like the extractor's) carries a 1s mtime-granularity tolerance, so files
  // created in the same second as a scan are always re-checked — realistic
  // steady-state benchmarking needs files that unambiguously predate it.
  const aged = new Date(Date.now() - 60_000);
  for (const f of fs.readdirSync(path.join(root, 'src'))) fs.utimesSync(path.join(root, 'src', f), aged, aged);
  for (const f of fs.readdirSync(path.join(root, 'docs'))) fs.utimesSync(path.join(root, 'docs', f), aged, aged);
}

function time(label, fn) {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  return { label, ms: Math.round(ms) };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-bench-'));
const env = { ...process.env, DOCRELAY_NO_UPDATE_CHECK: '1', DOCRELAY_PROJECT_ROOT: root };
const run = (cliArgs) => execFileSync(process.execPath, [CLI, ...cliArgs], { env, stdio: 'pipe' });

try {
  genProject(root);
  const results = [];
  results.push(time('init + full scan', () => run(['init', '--no-hooks', '--no-integrate'])));
  results.push(time('status', () => run(['status', '--format', 'json'])));
  results.push(time('check --strict', () => run(['check', '--strict'])));

  // No-op incremental: nothing changed since the init scan.
  results.push(time('scan --incremental (no-op)', () => run(['scan', '--incremental'])));

  // Touch 5% of source files (content change -> re-scan + re-sync work).
  const touched = Math.max(1, Math.floor(FILES * 0.05));
  for (let i = 0; i < touched; i++) {
    const p = path.join(root, 'src', `mod${i}.ts`);
    fs.appendFileSync(p, `\nexport function extra${i}(v: number): number { return v; }\n`);
    // mtime must exceed the 1s tolerance of the incremental cutoff.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(p, future, future);
  }
  results.push(time(`scan --incremental (5% = ${touched} files)`, () => run(['scan', '--incremental'])));
  results.push(time('review', () => run(['review'])));

  const meta = { files: FILES, docs: DOCS, symbols: FILES * FUNCS_PER_FILE, sections: DOCS * SECTIONS_PER_DOC };
  if (AS_JSON) {
    console.log(JSON.stringify({ meta, results }, null, 2));
  } else {
    console.log(`\nDocRelay bench — ${meta.symbols} symbols / ${meta.sections} doc sections (${FILES} files, ${DOCS} docs)\n`);
    for (const r of results) console.log(`  ${r.label.padEnd(40)} ${String(r.ms).padStart(7)} ms`);
    console.log('');
  }
} finally {
  if (KEEP) {
    console.error(`bench project kept at: ${root}`);
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
