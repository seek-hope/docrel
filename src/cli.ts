#!/usr/bin/env node
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeAllDbs } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { loadConfig } from './utils/config.js';
import { CodegraphClient } from './codegraph/client.js';
import { CodegraphExtractor } from './extractors/codegraph.js';
import { BuiltinExtractor } from './extractors/builtin.js';
import type { SymbolExtractor } from './extractors/interface.js';
import { docrelStatus } from './tools/status.js';
import { docrelCheck, formatCheckMarkdown, formatCheckCI } from './tools/check.js';
import { docrelImpact, formatImpactMarkdown } from './tools/impact.js';
import { syncSymbol, syncAllStale } from './sync/engine.js';
import { docrelLink, docrelConfirm, docrelReject } from './tools/link.js';
import { docrelDiff, formatDiffMarkdown } from './tools/diff.js';
import { installHooks, prepareCommitMsg } from './git/hooks.js';
import { exportMappingsJson, listAllMappings } from './db/mappings.js';
import { scanProject } from './discovery/scanner.js';
import { scanDocs } from './discovery/doc-scanner.js';
import { autoLink, ingestDocSections } from './discovery/auto-linker.js';
import { upsertDocSection } from './db/docs.js';
import { createMapping } from './db/mappings.js';
import { listSymbols } from './db/symbols.js';
import { docSectionId, contentHash } from './utils/hash.js';
import { checkForUpdates, isNewer } from './utils/update-check.js';
import { DOCREL_VERSION } from './version.js';
import { detectAgent } from './agents/detector.js';
import type { AgentKind } from './agents/detector.js';
import { integrate } from './agents/integrate.js';
import { docrelGc } from './tools/gc.js';
import { stringify as stringifyYaml } from 'yaml';

/** Safe error message: handles null, undefined, string, and non-Error throws.
 *  Sanitizes absolute filesystem paths to prevent information disclosure. */
function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? 'unknown error');
  // Sanitize project root paths from error messages
  return raw.replace(new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<projectRoot>');
}

/** Exit with database cleanup — ensures WAL checkpointing completes. */
function exit(code: number): never {
  try { closeAllDbs(); } catch { /* best effort */ }
  process.exit(code);
}

// F23: Register exit handler for synchronous WAL checkpointing.
// better-sqlite3's db.close() is synchronous (including WAL checkpoint),
// so the 'exit' event is safe. If a future version adds async behavior,
// index.ts:374 shows how to register a 'beforeExit' handler with a grace
// period. Keep 'exit' as a last-resort synchronous cleanup.
process.on('exit', () => {
  try { closeAllDbs(); } catch { /* best effort */ }
});

const program = new Command();
const projectRoot = process.env.DOCREL_PROJECT_ROOT ?? process.cwd();

let config: ReturnType<typeof loadConfig>;
let db: ReturnType<typeof getDb>;
let extractor: SymbolExtractor;
let codegraph: CodegraphClient;

try {
  config = loadConfig(projectRoot);
  db = getDb(projectRoot);
  runMigrations(db);
  codegraph = new CodegraphClient(config.codegraph?.command);
  const codegraphExtractor = new CodegraphExtractor(codegraph, config.codegraph?.maxFiles);
  const builtinExtractor = new BuiltinExtractor();
  // Try codegraph; fall back to builtin regex-based extraction
  extractor = (await codegraphExtractor.isAvailable()) ? codegraphExtractor : builtinExtractor;
} catch (err: any) {
  console.error('DocRel initialization failed:', errMsg(err));
  exit(1);
}

program
  .name('docrel')
  .description('Code-Documentation Relational Sync System')
  .version(DOCREL_VERSION);

program
  .command('init')
  .description('Initialize DocRel in the current project (config + DB + hooks + scan)')
  .option('--no-hooks', 'Skip installing git hooks')
  .option('--no-scan', 'Skip scanning the codebase (requires codegraph)')
  .option('--force', 'Overwrite existing config and hooks')
  .action(async (opts) => {
    try {
      notifyIfOutdated().catch(() => {}); // fire-and-forget update check
      const configPath = path.join(projectRoot, '.docrel', 'config.yaml');
      const docrelDir = path.join(projectRoot, '.docrel');
      let steps: string[] = [];

      // 1. Create .docrel/ directory with restrictive permissions (0o700)
      fs.mkdirSync(docrelDir, { recursive: true, mode: 0o700 });
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
        steps.push('Installed git hooks (pre-commit, post-commit, pre-push, prepare-commit-msg)');
      } else {
        steps.push('Skipped git hooks (run \'docrel install-hooks\' later)');
      }

      // 5. Scan codebase (unless --no-scan)
      if (opts.scan) {
        const available = await extractor.isAvailable();
        if (available) {
          const report = await scanProject(extractor, db, config, projectRoot);
          steps.push(`Scanned codebase: ${report.totalSymbols} symbols, ${report.newSymbols} new`);
        } else {
          steps.push('Skipped scan: no extractor available (run \'docrel scan\' later)');
        }
      } else {
        steps.push('Skipped scan (run \'docrel scan\' later or omit --no-scan)');
      }

      // 6. Summary
      console.log('DocRel initialized!\n');
      steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
      console.log(`\nNext: docrel status   — check documentation health`);
    } catch (err: any) {
      console.error('Init failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('status')
  .description('Show health dashboard')
  .option('--format <format>', 'Output format: json or markdown', 'json')
  .action((opts) => {
    try {
      notifyIfOutdated().catch(() => {}); // fire-and-forget update check
      const status = docrelStatus(db);
      if (status.error) {
        console.error('Status query failed:', status.error);
        exit(1);
      }
      if (opts.format === 'markdown') {
        console.log(`## DocRel Status
- Symbols: ${status.totalSymbols}
- Linked: ${status.linkedSymbols} (${status.linkedPercentage}%)
- Docs in sync: ${status.syncedDocs}/${status.totalDocs} (${status.syncPercentage}%)
- Pending changes: ${status.pendingChanges}`);
      } else {
        console.log(JSON.stringify(status, null, 2));
      }
    } catch (err: any) {
      console.error('Status failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('check')
  .description('Check for stale documentation')
  .option('--strict', 'Exit with code 1 if any docs are stale', false)
  .option('--file <file>', 'Check only a specific file')
  .option('--format <format>', 'Output format: json, markdown, or ci', 'json')
  .action((opts) => {
    try {
      const report = docrelCheck(db, opts.strict);
      // If the database query itself failed, report.error is set — treat
      // this as a hard failure regardless of staleDoc count.
      if (report.error && opts.format === 'json') {
        console.error('DocRel check failed:', report.error);
        exit(1);
      }
      let filtered = report.staleDocs;
      let filteredPassed = report.passed;
      let filteredSummary = report.summary;
      if (opts.file) {
        filtered = report.staleDocs.filter((d) => d.file === opts.file);
        // Recompute passed based on filtered results — do not use the
        // unfiltered report.passed which may be false due to stale docs
        // in other files.
        filteredPassed = !opts.strict || filtered.length === 0;
        // Recompute summary to match the filtered staleDocs array so the
        // output is not misleading (e.g., "5 stale across 3 files" when
        // the user filtered to a single file with 1 stale doc).
        const filteredFiles = [...new Set(filtered.map((d: { file: string }) => d.file))];
        filteredSummary = filtered.length === 0
          ? 'All documentation in sync.'
          : `${filtered.length} doc section(s) stale across ${filteredFiles.length} file(s): ${filteredFiles.join(', ')}`;
      }
      const outputReport = opts.file
        ? { ...report, passed: filteredPassed, summary: filteredSummary, staleDocs: filtered }
        : { ...report, passed: filteredPassed, staleDocs: filtered };

      if (opts.format === 'markdown') {
        console.log(formatCheckMarkdown(outputReport));
      } else if (opts.format === 'ci') {
        console.log(formatCheckCI(outputReport));
      } else {
        console.log(JSON.stringify(outputReport, null, 2));
      }
      if (opts.strict && filtered.length > 0) {
        exit(1);
      }
    } catch (err: any) {
      console.error('Check failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('impact')
  .description('Show documentation affected by changed files')
  .argument('<paths...>', 'Changed file paths')
  .option('--format <format>', 'Output format: json or markdown', 'json')
  .action((paths: string[], opts) => {
    try {
      const impact = docrelImpact(db, paths);
      if (opts.format === 'markdown') {
        console.log(formatImpactMarkdown(impact));
      } else {
        console.log(JSON.stringify(impact, null, 2));
      }
    } catch (err: any) {
      console.error('Impact analysis failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('sync')
  .description('Sync documentation for a symbol, or all stale docs with --all-stale')
  .option('--symbol <id>', 'Symbol ID to sync')
  .option('--all-stale', 'Sync all stale documentation sections')
  .action(async (opts) => {
    try {
      if (opts.allStale) {
        const result = await syncAllStale(db, codegraph, config, projectRoot);
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!opts.symbol) {
        console.error('Error: --symbol <id> is required (or use --all-stale)');
        exit(1);
      }
      const result = await syncSymbol(db, config, opts.symbol, projectRoot);
      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error('Sync failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('link')
  .description('Manage a symbol-doc mapping (create or delete only; use confirm/reject to change review status)')
  .argument('<action>', 'create or delete')
  .option('--symbol <id>', 'Symbol ID')
  .option('--doc <id>', 'Document section ID')
  .option('--type <type>', 'Relationship type', 'describes')  .action((action, opts) => {
    try {
      if (!opts.symbol) { console.error('Error: --symbol <id> is required'); exit(1); }
      if (!opts.doc) { console.error('Error: --doc <id> is required'); exit(1); }
      if (!['create', 'delete'].includes(action)) {
        console.error(`Error: action must be 'create' or 'delete', got '${action}'`);
        exit(1);
      }const result = docrelLink(db, {
        action: action as 'create' | 'delete',
        symbol_id: opts.symbol,
        doc_id: opts.doc,
        rel_type: opts.type,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.action === 'error') exit(1);
    } catch (err: any) {
      console.error('Link failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('confirm')
  .description('Confirm an auto-generated mapping as correct — sets review_status to confirmed')
  .option('--symbol <id>', 'Symbol ID')
  .option('--doc <id>', 'Document section ID')
  .option('--type <type>', 'Relationship type', 'describes')
  .action((opts) => {
    try {
      if (!opts.symbol) { console.error('Error: --symbol <id> is required'); exit(1); }
      if (!opts.doc) { console.error('Error: --doc <id> is required'); exit(1); }
      const result = docrelConfirm(db, opts.symbol, opts.doc, opts.type);
      console.log(JSON.stringify(result, null, 2));
      if (result.action === 'error') exit(1);
    } catch (err: any) {
      console.error('Confirm failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('reject')
  .description('Reject an auto-generated mapping as incorrect — sets review_status to rejected')
  .option('--symbol <id>', 'Symbol ID')
  .option('--doc <id>', 'Document section ID')
  .option('--type <type>', 'Relationship type', 'describes')
  .action((opts) => {
    try {
      if (!opts.symbol) { console.error('Error: --symbol <id> is required'); exit(1); }
      if (!opts.doc) { console.error('Error: --doc <id> is required'); exit(1); }
      const result = docrelReject(db, opts.symbol, opts.doc, opts.type);
      console.log(JSON.stringify(result, null, 2));
      if (result.action === 'error') exit(1);
    } catch (err: any) {
      console.error('Reject failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('diff')
  .description('Show change history for a symbol')
  .argument('<symbol_id>', 'Symbol ID')
  .option('--format <format>', 'Output format: json or markdown', 'json')
  .action((symbolId, opts) => {
    try {
      const diff = docrelDiff(db, symbolId);
      if (!diff.found) {
        console.error(diff.message || 'Symbol not found');
        exit(1);
      }
      if (opts.format === 'markdown' && diff.report) {
        console.log(formatDiffMarkdown(diff.report));
      } else {
        console.log(JSON.stringify(diff.report, null, 2));
      }
    } catch (err: any) {
      console.error('Diff failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('install-hooks')
  .description('Install DocRel git hooks in .git/hooks/')
  .action(() => {
    try {
      installHooks(projectRoot);
      console.log('DocRel hooks installed successfully.');
    } catch (err: any) {
      console.error('Failed to install hooks:', errMsg(err));
      exit(1);
    }
  });

program
  .command('annotate-commit')
  .description('Annotate a commit message with DocRel summary stats')
  .argument('<commit-msg-file>', 'Path to the commit message file')
  .action((commitMsgFile: string) => {
    try {
      const summary = prepareCommitMsg(db);
      const fullPath = path.resolve(projectRoot, commitMsgFile);
      let existing = '';
      try {
        existing = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        // File may not exist yet (e.g., git commit without -m); start fresh
      }
      // Append summary after existing message, separated by a blank line
      const annotated = existing.trimEnd() + '\n\n' + summary + '\n';
      fs.writeFileSync(fullPath, annotated, 'utf-8');
    } catch (err: any) {
      console.error('Failed to annotate commit message:', errMsg(err));
      exit(1);
    }
  });

program
  .command('watch')
  .description('Watch for file changes and auto-update mappings (for non-agent use)')
  .action(async () => {
    const { startWatch } = await import('./tools/watch.js');
    const cleanup = await startWatch(projectRoot, db, extractor, config);
    // Keep running until SIGINT
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  });

program
  .command('scan')
  .description('Scan the codebase and discover all symbols and documentation sections')
  .option('--no-docs', 'Skip scanning documentation files')
  .action(async (opts) => {
    try {
      // Pick extractor: try CodegraphExtractor, fall back to BuiltinExtractor
      const codegraphExt = new CodegraphExtractor(codegraph, config.codegraph?.maxFiles);
      const builtinExt = new BuiltinExtractor();
      const codegraphAvailable = await codegraphExt.isAvailable();
      const scanExtractor = codegraphAvailable ? codegraphExt : builtinExt;

      if (codegraphAvailable) {
        console.error('Using Codegraph extractor');
      } else {
        console.error('Codegraph not available — falling back to builtin regex extractor');
      }

      // Scan symbols via extractor
      console.error('Scanning codebase...');
      const symbolReport = await scanProject(scanExtractor, db, config, projectRoot);

      let docSectionReport: {
        totalFiles: number;
        totalSections: number;
        newDocSections: number;
        newMappings: number;
        failedFiles: string[];
      } | null = null;
      let autoLinkReport: {
        totalMatched: number;
        highConfidence: number;
        mediumConfidence: number;
        lowConfidence: number;
      } | null = null;

      if (opts.docs !== false) {
        // Scan docs via scanDocs()
        console.error('Scanning documentation...');
        const { sections, report: docReport } = await scanDocs(config.doc_dirs, projectRoot);
        const ingestResult = ingestDocSections(db, sections);

        docSectionReport = {
          totalFiles: docReport.totalFiles,
          totalSections: docReport.totalSections,
          newDocSections: ingestResult.newDocSections,
          newMappings: ingestResult.newMappings,
          failedFiles: docReport.failedFiles,
        };

        // Auto-link via autoLink() — creates zero-annotation symbol↔doc mappings
        const allSymbols = listSymbols(db);
        autoLinkReport = autoLink(db, allSymbols, sections);
      }

      // Report full results as a single JSON object
      console.log(JSON.stringify({
        symbols: symbolReport,
        docs: docSectionReport,
        autoLink: autoLinkReport,
      }, null, 2));
    } catch (err: any) {
      console.error('Scan failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('review')
  .description('Audit code-doc mappings: unlinked symbols, orphaned sections, implied refs')
  .option('--format <format>', 'Output format: json, markdown, or detailed', 'markdown')
  .option('--json', 'Shortcut for --format json')
  .option('-S, --side-by-side', 'Show code↔doc blocks for unreviewed mappings')
  .action(async (opts) => {
    try {
      const { docrelReview, formatReview, formatReviewDetailed } = await import('./tools/review.js');
      const report = docrelReview(db, projectRoot);
      if (opts.json || opts.format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else if (opts.sideBySide || opts.format === 'detailed') {
        console.log(formatReviewDetailed(report, projectRoot));
      } else {
        console.log(formatReview(report));
      }
    } catch (err: any) {
      console.error('Review failed:', errMsg(err));
      exit(1);
    }
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
      console.error(`Failed to export mappings: ${errMsg(err)}`);
      exit(1);
    }
  });

program
  .command('integrate')
  .description('Generate agent integration configs for DocRel')
  .option('--agent <agent>', 'Agent to integrate with (claude-code, codex, opencode, oh-my-pi, hermes)')
  .option('--dry-run', 'Preview what would be created without writing files')
  .action(async (opts) => {
    try {
      const detected = detectAgent();
      const agentKind: AgentKind | undefined = opts.agent as AgentKind | undefined;

      // Validate agent flag if provided
      const VALID_AGENTS = new Set(['claude-code', 'codex', 'opencode', 'oh-my-pi', 'hermes', 'unknown']);
      if (opts.agent && !VALID_AGENTS.has(opts.agent)) {
        console.error(`Error: Unknown agent '${opts.agent}'. Valid: ${[...VALID_AGENTS].join(', ')}`);
        exit(1);
      }

      const targetAgent = agentKind ?? detected.kind;

      if (opts.dryRun) {
        console.error(`Detected agent: ${detected.name} (${detected.kind})`);
        if (agentKind) {
          console.error(`Overriding with: ${agentKind}`);
        }
        console.error('Dry run — no files will be written.\n');
      }

      const result = await integrate(projectRoot, targetAgent, opts.dryRun ?? false);

      if (opts.dryRun) {
        if (result.filesCreated.length > 0) {
          console.log(`Would create/update: ${result.filesCreated.join(', ')}`);
        } else {
          console.log('No changes needed — integration already configured.');
        }
      } else {
        console.log(result.summary);
      }
    } catch (err: any) {
      console.error('Integrate failed:', errMsg(err));
      exit(1);
    }
  });

// ── background update check (non-blocking, cached daily) ────


async function notifyIfOutdated(): Promise<void> {
  try {
    const latest = await checkForUpdates(DOCREL_VERSION);
    if (latest && isNewer(DOCREL_VERSION, latest)) {
      console.error(`\n  DocRel ${latest} is available (you have ${DOCREL_VERSION}). Run 'docrel update' to upgrade.\n`);
    }
  } catch {
    // Never let update check break the main command
  }
}

program
  .command('update')
  .description('Update DocRel to the latest version via npm')
  .action(() => {
    try {
      // Resolve npm binary path with TOCTOU-safe validation matching the
      // pattern used in client.ts doConnect() and hooks.ts installHooks().
      let npmBin: string;
      try {
        const whichOutput = execFileSync('which', ['npm'], { encoding: 'utf-8' }).trim();
        if (!whichOutput) throw new Error('npm not found on PATH');
        const realBin = fs.realpathSync(whichOutput);
        const allowedPrefixes = ['/usr/', '/opt/', '/home/', '/run/current-system/'];
        if (!allowedPrefixes.some((p) => realBin.startsWith(p))) {
          // F15: Sanitize the path to avoid disclosing full filesystem paths
          // in CI/monitoring logs. Show only the prefix for diagnostics.
          console.error(`Security warning: npm binary resolved to unexpected location (prefix: ${realBin.slice(0, 30)}...)`);
          exit(1);
        }
        // Verify the binary actually works before executing
        try {
          execFileSync(realBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
        } catch {
          console.error(`Resolved npm binary at ${realBin} does not appear to work.`);
          exit(1);
        }
        npmBin = realBin;
      } catch (err: any) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          console.error("Cannot locate npm: 'which' utility is not available on this system. Try updating manually with: npm install -g docrel@latest");
        } else {
          console.error(`Cannot locate npm binary: ${err.message || err}`);
        }
        exit(1);
      }

      // Validate npm registry before executing install
      let registry: string;
      try {
        registry = execFileSync(npmBin, ['config', 'get', 'registry'], { encoding: 'utf-8' }).trim();
      } catch {
        registry = 'https://registry.npmjs.org/';
      }
      if (!registry.startsWith('https://registry.npmjs.org/') && !registry.startsWith('https://registry.yarnpkg.com/')) {
        console.error(`Security warning: npm registry is set to ${registry}. Expected https://registry.npmjs.org/. Aborting update.`);
        exit(1);
      }

      console.log('Updating DocRel...');
      console.warn('Note: global install (-g) may require elevated privileges.');
      const output = execFileSync(npmBin, ['install', '-g', 'docrel@latest', '--ignore-scripts'], { encoding: 'utf-8', timeout: 60_000 });
      console.log(output || 'DocRel updated to the latest version.');
    } catch (err: any) {
      // npm stderr may contain absolute filesystem paths (global install
      // prefixes, npm config paths, etc.). Log the full output only when
      // DOCREL_DEBUG is enabled; otherwise show a generic message.
      if (process.env.DOCREL_DEBUG === '1' || process.env.DOCREL_DEBUG === 'true') {
        console.error(`Update failed: ${err.stderr ?? err.message}`);
      } else {
        console.error('Update failed: npm install returned an error. Run with DOCREL_DEBUG=1 for details.');
      }
      console.error('Try: npm install -g docrel@latest');
      exit(1);
    }
  });

const configCommand = program
  .command('config')
  .description('Show resolved configuration');

configCommand
  .command('show')
  .description('Show resolved config (defaults merged with user overrides) in YAML format')
  .action(() => {
    try {
      const resolved = loadConfig(projectRoot);
      console.log(stringifyYaml(resolved));
    } catch (err: any) {
      console.error('Config failed:', errMsg(err));
      exit(1);
    }
  });

// Default action for `docrel config` (no subcommand) → show config
configCommand.action(() => {
  try {
    const resolved = loadConfig(projectRoot);
    console.log(stringifyYaml(resolved));
  } catch (err: any) {
    console.error('Config failed:', errMsg(err));
    exit(1);
  }
});

program
  .command('reset')
  .description('Delete the DocRel database and re-run migrations (destructive)')
  .option('--force', 'Skip confirmation prompt')
  .action(async (opts) => {
    try {
      if (!opts.force) {
        console.error('WARNING: This will delete the DocRel database (.git/docrel.db or .docrel/docrel.db).');
        console.error('All symbol mappings, changelog history, and scan metadata will be lost.');
        console.error('This is irreversible.');
        console.error('');

        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        const answer = await new Promise<string>((resolve) => {
          rl.question('Type "yes" to confirm: ', (a) => { rl.close(); resolve(a); });
        });
        if (answer.trim() !== 'yes') {
          console.error('Reset cancelled.');
          exit(0);
        }
      }

      // Determine the database path (check .git/ then .docrel/)
      const gitDbPath = path.join(projectRoot, '.git', 'docrel.db');
      const docrelDbPath = path.join(projectRoot, '.docrel', 'docrel.db');
      let dbPath = '';
      if (fs.existsSync(gitDbPath)) {
        dbPath = gitDbPath;
      } else if (fs.existsSync(docrelDbPath)) {
        dbPath = docrelDbPath;
      }

      // Close existing database connections
      closeAllDbs();

      // Delete the database and companion files
      if (dbPath) {
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.unlinkSync(dbPath + '-wal'); } catch {}
        try { fs.unlinkSync(dbPath + '-shm'); } catch {}
        console.error(`Deleted database: ${dbPath.replace(projectRoot, '<projectRoot>')}`);
      }

      // Re-initialize: open a fresh database and run migrations
      db = getDb(projectRoot);
      runMigrations(db);

      console.error('DocRel database has been reset and re-initialized.');
    } catch (err: any) {
      console.error('Reset failed:', errMsg(err));
      exit(1);
    }
  });

program
  .command('gc')
  .description('Garbage-collect symbols no longer found in the codebase (two-pass: stale then delete)')
  .option('--dry-run', 'Preview what would be removed without deleting')
  .action(async (opts) => {
    // Resolve extractor at action time (same fallback logic as `scan` command).
    // The top-level extractor may have been initialized before codegraph was
    // available; re-create and re-check here for the gc action.
    try {
      const codegraphExt = new CodegraphExtractor(codegraph, config.codegraph?.maxFiles);
      const builtinExt = new BuiltinExtractor();
      const codegraphAvailable = await codegraphExt.isAvailable();
      const gcExtractor = codegraphAvailable ? codegraphExt : builtinExt;

      if (codegraphAvailable) {
        console.error('Using Codegraph extractor');
      } else {
        console.error('Codegraph not available — falling back to builtin regex extractor');
      }

      console.error('Scanning codebase for GC...');
      const scanReport = await scanProject(gcExtractor, db, config, projectRoot);

      console.error('Running garbage collection...');
      const gcReport = docrelGc(db, scanReport, opts.dryRun ?? false);

      if (gcReport.dryRun) {
        console.error(`[dry-run] Would remove ${gcReport.symbolsRemoved} symbol(s), would mark ${gcReport.symbolsMarkedStale} symbol(s) as stale`);
      } else {
        console.error(`${gcReport.symbolsRemoved} symbol(s) removed, ${gcReport.symbolsMarkedStale} symbol(s) marked as stale`);
      }
    } catch (err: any) {
      console.error('GC failed:', errMsg(err));
      exit(1);
    }
  });

program.parse();
