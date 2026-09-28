// Scan performance benchmark for DocRelay development.
// Usage: node scripts/bench-scan.mjs  (env: BENCH_FILES=100 BENCH_FUNCS=30)
//
// Generates a synthetic TypeScript project (default: 100 files × 30 exported
// functions = 3000 symbols), then times a full first scan and a no-change
// rescan using the builtin extractor against the compiled dist/ build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-bench-'));
fs.mkdirSync(path.join(dir, '.docrelay'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src'));
fs.mkdirSync(path.join(dir, '.git'));
fs.writeFileSync(
  path.join(dir, '.docrelay', 'config.yaml'),
  'version: 1\nproject: bench\ndoc_dirs: []\ncode_dirs:\n  - src\n',
);

const FILES = Number(process.env.BENCH_FILES ?? 100);
const FUNCS = Number(process.env.BENCH_FUNCS ?? 30);
for (let f = 0; f < FILES; f++) {
  let src = '';
  for (let i = 0; i < FUNCS; i++) {
    src += `/** Doc for fn${f}_${i} */\nexport function fn${f}_${i}(a: number): number { return a + ${i}; }\n\n`;
  }
  fs.writeFileSync(path.join(dir, 'src', `mod${f}.ts`), src);
}

const { getDb, closeAllDbs } = await import(path.join(distRoot, 'dist', 'db', 'connection.js'));
const { runMigrations } = await import(path.join(distRoot, 'dist', 'db', 'schema.js'));
const { scanProject } = await import(path.join(distRoot, 'dist', 'discovery', 'scanner.js'));
const { BuiltinExtractor } = await import(path.join(distRoot, 'dist', 'extractors', 'builtin.js'));
const { loadConfig } = await import(path.join(distRoot, 'dist', 'utils', 'config.js'));

const db = getDb(dir);
runMigrations(db);
const config = loadConfig(dir);

const t0 = performance.now();
const report1 = await scanProject(new BuiltinExtractor(), db, config, dir, true);
const t1 = performance.now();
const report2 = await scanProject(new BuiltinExtractor(), db, config, dir, true);
const t2 = performance.now();

console.log(JSON.stringify({
  symbols: report1.totalSymbols,
  newSymbols: report1.newSymbols,
  firstScanMs: Math.round(t1 - t0),
  rescanMs: Math.round(t2 - t1),
  rescanNew: report2.newSymbols,
  rescanUpdated: report2.updatedSymbols,
}, null, 2));

closeAllDbs();
fs.rmSync(dir, { recursive: true, force: true });
