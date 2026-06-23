#!/usr/bin/env node
import { Command } from 'commander';
import { getDb } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { loadConfig } from './utils/config.js';
import { CodegraphClient } from './codegraph/client.js';
import { docrelStatus } from './tools/status.js';
import { docrelCheck } from './tools/check.js';
import { docrelImpact } from './tools/impact.js';
import { syncSymbol } from './sync/engine.js';
import { docrelLink } from './tools/link.js';
import { docrelDiff } from './tools/diff.js';
import { installHooks } from './git/hooks.js';

const program = new Command();
const projectRoot = process.env.DOCREL_PROJECT_ROOT ?? process.cwd();

let config: ReturnType<typeof loadConfig>;
let db: ReturnType<typeof getDb>;
let codegraph: CodegraphClient;

try {
  config = loadConfig(projectRoot);
  db = getDb(projectRoot);
  runMigrations(db);
  codegraph = new CodegraphClient(config.codegraph?.command);
} catch (err: any) {
  console.error('DocRel initialization failed:', err.message);
  process.exit(1);
}

program
  .name('docrel')
  .description('Code-Documentation Relational Sync System')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize DocRel in the current project (config + DB + hooks + scan)')
  .option('--no-hooks', 'Skip installing git hooks')
  .option('--no-scan', 'Skip scanning the codebase (requires codegraph)')
  .option('--force', 'Overwrite existing config and hooks')
  .action(async (opts) => {
    const configPath = path.join(projectRoot, '.docrel', 'config.yaml');
    const docrelDir = path.join(projectRoot, '.docrel');
    let steps: string[] = [];

    // 1. Create .docrel/ directory
    fs.mkdirSync(docrelDir, { recursive: true });
    steps.push('Created .docrel/ directory');

    // 2. Write default config if missing (or --force)
    if (!fs.existsSync(configPath) || opts.force) {
      const defaultConfig = `# DocRel configuration — see https://github.com/seek-hope/docrel
project: ${path.basename(projectRoot)}
doc_dirs:
  - docs
  - README.md
code_dirs:
  - src
strategies:
  inline: auto_update       # Docstrings in source — rewrite directly
  standalone: auto_update   # Markdown docs — generate diff, agent reviews
  generated: auto_update    # TypeDoc/OpenAPI — re-run generator
  architecture: mark_stale  # Architecture docs — flag for review only
`;
      fs.writeFileSync(configPath, defaultConfig, 'utf-8');
      steps.push(`${opts.force && fs.existsSync(configPath) ? 'Overwrote' : 'Created'} .docrel/config.yaml`);
    } else {
      steps.push('.docrel/config.yaml already exists (use --force to overwrite)');
    }

    // 3. Initialize database
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    steps.push('Initialized database (.git/docrel.db)');

    // 4. Install git hooks (unless --no-hooks)
    if (opts.hooks) {
      installHooks(projectRoot, opts.force);
      steps.push('Installed git hooks (pre-commit, post-commit, pre-push)');
    } else {
      steps.push('Skipped git hooks (run \'docrel install-hooks\' later)');
    }

    // 5. Scan codebase (unless --no-scan)
    if (opts.scan) {
      const available = await codegraph.isAvailable();
      if (available) {
        const report = await scanProject(codegraph, db, config);
        steps.push(`Scanned codebase: ${report.totalSymbols} symbols, ${report.newSymbols} new`);
      } else {
        steps.push('Skipped scan: codegraph not available (run \'docrel scan\' later)');
      }
    } else {
      steps.push('Skipped scan (run \'docrel scan\' later or omit --no-scan)');
    }

    // 6. Summary
    console.log('DocRel initialized!\n');
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    console.log(`\nNext: docrel status   — check documentation health`);
  });

program
  .command('status')
  .description('Show health dashboard')
  .option('--format <format>', 'Output format: json or markdown', 'json')
  .action((opts) => {
    const status = docrelStatus(db);
    if (opts.format === 'markdown') {
      console.log(`## DocRel Status
- Symbols: ${status.totalSymbols}
- Linked: ${status.linkedSymbols} (${status.linkedPercentage}%)
- Docs in sync: ${status.syncedDocs}/${status.totalDocs} (${status.syncPercentage}%)
- Pending changes: ${status.pendingChanges}`);
    } else {
      console.log(JSON.stringify(status, null, 2));
    }
  });

program
  .command('check')
  .description('Check for stale documentation')
  .option('--strict', 'Exit with code 1 if any docs are stale', false)
  .option('--file <file>', 'Check only a specific file')
  .action((opts) => {
    const report = docrelCheck(db, opts.strict);
    let filtered = report.staleDocs;
    if (opts.file) {
      filtered = report.staleDocs.filter((d) => d.file === opts.file);
    }
    console.log(JSON.stringify({ ...report, staleDocs: filtered }, null, 2));
    if (opts.strict && filtered.length > 0) {
      process.exit(1);
    }
  });

program
  .command('impact')
  .description('Show documentation affected by changed files')
  .argument('<paths...>', 'Changed file paths')
  .action((paths: string[]) => {
    const impact = docrelImpact(db, paths);
    console.log(JSON.stringify(impact, null, 2));
  });

program
  .command('sync')
  .description('Sync documentation for a symbol')
  .option('--symbol <id>', 'Symbol ID to sync')
  .action(async (opts) => {
    try {
      if (!opts.symbol) {
        console.error('Error: --symbol <id> is required');
        process.exit(1);
      }
      const result = await syncSymbol(db, codegraph, config, opts.symbol, projectRoot);
      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error('Sync failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('link')
  .description('Create or delete a symbol-doc mapping')
  .argument('<action>', 'create or delete')
  .option('--symbol <id>', 'Symbol ID')
  .option('--doc <id>', 'Document section ID')
  .option('--type <type>', 'Relationship type', 'describes')
  .action((action, opts) => {
    if (!opts.symbol) {
      console.error('Error: --symbol <id> is required');
      process.exit(1);
    }
    if (!opts.doc) {
      console.error('Error: --doc <id> is required');
      process.exit(1);
    }
    if (action !== 'create' && action !== 'delete') {
      console.error(`Error: action must be 'create' or 'delete', got '${action}'`);
      process.exit(1);
    }
    const result = docrelLink(db, {
      action: action as 'create' | 'delete',
      symbol_id: opts.symbol,
      doc_id: opts.doc,
      rel_type: opts.type,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('diff')
  .description('Show change history for a symbol')
  .argument('<symbol_id>', 'Symbol ID')
  .action((symbolId) => {
    const diff = docrelDiff(db, symbolId);
    if (!diff) {
      console.error('Symbol not found');
      process.exit(1);
    }
    console.log(JSON.stringify(diff, null, 2));
  });

program
  .command('install-hooks')
  .description('Install DocRel git hooks in .git/hooks/')
  .action(() => {
    installHooks(projectRoot);
    console.log('DocRel hooks installed successfully.');
  });

import { exportMappingsJson } from './db/mappings.js';
import { scanProject } from './discovery/scanner.js';
import fs from 'node:fs';
import path from 'node:path';

program
  .command('scan')
  .description('Scan the codebase via codegraph and discover all symbols')
  .action(async () => {
    const available = await codegraph.isAvailable();
    if (!available) {
      console.error('Codegraph is not available. Start codegraph first, or set codegraph.command in .docrel/config.yaml');
      process.exit(1);
    }
    console.log('Scanning codebase...');
    const report = await scanProject(codegraph, db, config);
    console.log(JSON.stringify(report, null, 2));
  });

program
  .command('export-mappings')
  .description('Export mappings to .docrel/mappings.json (for CodeGraph integration)')
  .action(() => {
    try {
      const mappings = exportMappingsJson(db);
      const docrelDir = path.join(projectRoot, '.docrel');
      fs.mkdirSync(docrelDir, { recursive: true });
      const outPath = path.join(docrelDir, 'mappings.json');
      fs.writeFileSync(outPath, JSON.stringify(mappings, null, 2), 'utf-8');
      console.log(`Exported ${mappings.length} mappings to ${outPath}`);
    } catch (err: any) {
      console.error(`Failed to export mappings: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
