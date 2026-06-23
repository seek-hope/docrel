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
const config = loadConfig(projectRoot);
const db = getDb(projectRoot);
const codegraph = new CodegraphClient(config.codegraph?.command);

runMigrations(db);

program
  .name('docrel')
  .description('Code-Documentation Relational Sync System')
  .version('0.1.0');

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
  .action(async (paths: string[]) => {
    const impact = await docrelImpact(db, codegraph, paths);
    console.log(JSON.stringify(impact, null, 2));
  });

program
  .command('sync')
  .description('Sync documentation for a symbol')
  .option('--symbol <id>', 'Symbol ID to sync')
  .action(async (opts) => {
    if (opts.symbol) {
      const result = await syncSymbol(db, codegraph, config, opts.symbol);
      console.log(JSON.stringify(result, null, 2));
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

program.parse();
