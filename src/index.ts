// src/index.ts — DocSync MCP Server entry point
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DOCSYNC_VERSION } from './version.js';
import { getDb, closeAllDbs } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { loadConfig } from './utils/config.js';
import type { DocSyncConfig } from './utils/config.js';
import { CodegraphClient } from './codegraph/client.js';
import { CodegraphExtractor } from './extractors/codegraph.js';
import { BuiltinExtractor } from './extractors/builtin.js';
import type { SymbolExtractor } from './extractors/interface.js';
import { docsyncStatus } from './tools/status.js';
import { docsyncCheck } from './tools/check.js';
import { docsyncImpact } from './tools/impact.js';
import { syncSymbol, syncAllStale } from './sync/engine.js';
import { docsyncLink } from './tools/link.js';
import { docsyncDiff } from './tools/diff.js';
import { scanProject } from './discovery/scanner.js';
import { scanDocs } from './discovery/doc-scanner.js';
import { autoLink, ingestDocSections } from './discovery/auto-linker.js';
import { listSymbols } from './db/symbols.js';
import { detectAgent } from './agents/detector.js';
import type { AgentKind } from './agents/detector.js';
import { integrate } from './agents/integrate.js';

const DOCSYNC_DEBUG = process.env.DOCSYNC_DEBUG === '1' || process.env.DOCSYNC_DEBUG === 'true';

/** Sanitize an error for MCP client responses. Logs the full error to stderr
 *  and returns a generic message that does not disclose internal paths or details. */
function sanitizeError(err: unknown): string {
  console.error('DocSync MCP tool error:', err instanceof Error ? err.message : err);
  if (DOCSYNC_DEBUG && err instanceof Error && err.stack) {
    console.error('DocSync MCP tool error (debug stack):', err.stack);
  }
  return 'Internal error — check server logs.';
}

const projectRoot = process.env.DOCSYNC_PROJECT_ROOT ?? process.cwd();

// When DOCSYNC_PROJECT_ROOT is not set, verify .docsync/config.yaml exists in CWD.
// If it does not, the MCP server will initialize against the wrong directory
// (silently creating a DB in a random location).
if (!process.env.DOCSYNC_PROJECT_ROOT) {
  if (!fs.existsSync(path.join(projectRoot, '.docsync', 'config.yaml'))) {
    console.error('DocSync: DOCSYNC_PROJECT_ROOT not set and .docsync/config.yaml not found in CWD.');
    console.error('Set DOCSYNC_PROJECT_ROOT or run from the project root directory.');
    process.exit(1);
  }
}

let config: DocSyncConfig;
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
  console.error('Failed to initialize DocSync:', err.message);
  try { closeAllDbs(); } catch {}
  process.exit(1);
}

const server = new McpServer({
  name: 'docsync',
  version: DOCSYNC_VERSION,
});

// ── docsync_status ──────────────────────────────────────────────
server.tool(
  'docsync_status',
  'Get the overall health dashboard of code-documentation synchronization',
  async () => {
    try {
      const status = docsyncStatus(db);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_check ───────────────────────────────────────────────
server.tool(
  'docsync_check',
  'Check for stale documentation. Use strict=true to fail on any stale docs.',
  {
    strict: z.boolean().optional().default(false),
    file: z.string().optional().describe('Check only a specific file'),
  },
  async ({ strict, file }) => {
    try {
      const report = docsyncCheck(db, strict);
      if (file) {
        // Propagate error context into filtered responses so MCP clients
        // can detect that the check failed, even when file-filtering would
        // otherwise produce an empty staleDocs list.
        if (report.error) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                passed: false,
                staleDocs: [],
                summary: `Check failed for ${file}: ${report.error}`,
                error: report.error,
              }, null, 2),
            }],
          };
        }
        const filtered = report.staleDocs.filter((d) => d.file === file);
        // Recompute passed from filtered results — matching CLI logic at
        // cli.ts:201. Do not use report.passed which reflects the unfiltered
        // result and may be false even when the requested file is clean.
        const filteredPassed = !strict || filtered.length === 0;
        const filteredFiles = [...new Set(filtered.map((d: { file: string }) => d.file))];
        const filteredSummary = filtered.length === 0
          ? 'All documentation in sync.'
          : `${filtered.length} stale doc(s) in ${filteredFiles.join(', ')}`;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              passed: filteredPassed,
              staleDocs: filtered,
              summary: filteredSummary,
            }, null, 2),
          }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_impact ──────────────────────────────────────────────
server.tool(
  'docsync_impact',
  'Analyze which documentation sections are affected by code changes',
  {
    paths: z.array(z.string()).describe('List of changed file paths'),
  },
  async ({ paths }) => {
    try {
      const impact = docsyncImpact(db, paths);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(impact, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_sync ────────────────────────────────────────────────
server.tool(
  'docsync_sync',
  'Synchronize documentation for a specific symbol (CASCADE update)',
  {
    symbol_id: z.string().describe('Stable symbol ID to sync docs for'),
  },
  async ({ symbol_id }) => {
    try {
      const result = await syncSymbol(db, config, symbol_id, projectRoot, codegraph);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_sync_all ────────────────────────────────────────────
server.tool(
  'docsync_sync_all',
  'Synchronize all stale documentation sections in batch',
  async () => {
    try {
      const result = await syncAllStale(db, codegraph, config, projectRoot);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_link ────────────────────────────────────────────────
server.tool(
  'docsync_link',
  'Manage a mapping between a code symbol and a documentation section (create, update review_status, or delete)',
  {
    action: z.enum(['create', 'delete']),
    symbol_id: z.string(),
    doc_id: z.string(),
    rel_type: z.enum(['describes', 'references', 'generates', 'contracts']),
    review_status: z.enum(['auto', 'confirmed', 'rejected']).optional().describe('Review status: auto (default), confirmed (human/AI verified), or rejected'),
  },
  async ({ action, symbol_id, doc_id, rel_type, review_status }) => {
    try {
      const result = docsyncLink(db, { action, symbol_id, doc_id, rel_type, review_status: review_status ?? 'auto' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_confirm ─────────────────────────────────────────────
server.tool(
  'docsync_confirm',
  'Confirm an auto-generated mapping as correct — sets review_status to confirmed (human/AI verified)',
  {
    symbol_id: z.string(),
    doc_id: z.string(),
    rel_type: z.enum(['describes', 'references', 'generates', 'contracts']).optional().default('describes'),
  },
  async ({ symbol_id, doc_id, rel_type }) => {
    try {
      const { docsyncConfirm } = await import('./tools/link.js');
      const result = docsyncConfirm(db, symbol_id, doc_id, rel_type);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_reject ──────────────────────────────────────────────
server.tool(
  'docsync_reject',
  'Reject an auto-generated mapping as incorrect — sets review_status to rejected',
  {
    symbol_id: z.string(),
    doc_id: z.string(),
    rel_type: z.enum(['describes', 'references', 'generates', 'contracts']).optional().default('describes'),
  },
  async ({ symbol_id, doc_id, rel_type }) => {
    try {
      const { docsyncReject } = await import('./tools/link.js');
      const result = docsyncReject(db, symbol_id, doc_id, rel_type);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_diff ────────────────────────────────────────────────
server.tool(
  'docsync_diff',
  'Show the diff of changes for a symbol and its linked documentation',
  {
    symbol_id: z.string().describe('Stable symbol ID'),
  },
  async ({ symbol_id }) => {
    try {
      const diff = docsyncDiff(db, symbol_id);
      if (!diff.found) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: diff.message || 'Symbol not found', reason: diff.reason }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(diff.report, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_scan ────────────────────────────────────────────────
server.tool(
  'docsync_scan',
  'Scan the codebase for symbols and documentation sections, then auto-link them',
  {
    docs: z.boolean().optional().default(true).describe('Also scan documentation files'),
  },
  async ({ docs }) => {
    try {
      const available = await extractor.isAvailable();
      if (!available) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No symbol extractor is available.' }) }],
          isError: true,
        };
      }

      const symbolReport = await scanProject(extractor, db, config, projectRoot, true /* full */);

      let docReport: { totalFiles: number; totalSections: number; newDocSections: number; newMappings: number; failedFiles: string[] } | null = null;
      let linkResult: { totalMatched: number; highConfidence: number; mediumConfidence: number; lowConfidence: number } | null = null;

      if (docs) {
        const { sections, report } = await scanDocs(config.doc_dirs, projectRoot);
        const ingestResult = ingestDocSections(db, sections);

        docReport = {
          totalFiles: report.totalFiles,
          totalSections: report.totalSections,
          newDocSections: ingestResult.newDocSections,
          newMappings: ingestResult.newMappings,
          failedFiles: report.failedFiles,
        };

        // Run auto-linker
        const allSymbols = listSymbols(db);
        linkResult = autoLink(db, allSymbols, sections);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            symbols: symbolReport,
            docs: docReport,
            autoLink: linkResult,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_review ──────────────────────────────────────────────
server.tool(
  'docsync_review',
  'Audit code-doc mappings: find unlinked symbols, orphaned sections, implied references, and unreviewed (auto-generated) mappings',
  {
    format: z.enum(['json', 'markdown']).optional().default('markdown').describe('Output format'),
  },
  async ({ format }) => {
    try {
      const { docsyncReview, formatReview } = await import('./tools/review.js');
      const report = docsyncReview(db, projectRoot);
      const text = format === 'json' ? JSON.stringify(report, null, 2) : formatReview(report);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_integrate ───────────────────────────────────────────
server.tool(
  'docsync_integrate',
  'Generate agent integration configs so DocSync is available in your coding agent (Claude Code, OpenCode, Oh My Pi, etc.)',
  {
    agent: z.enum(['claude-code', 'codex', 'opencode', 'oh-my-pi', 'hermes']).optional().describe('Agent to integrate with. If omitted, auto-detects the current agent.'),
    dryRun: z.boolean().optional().default(false).describe('Preview what would be created without writing files'),
  },
  async ({ agent, dryRun }) => {
    try {
      const detected = detectAgent();
      const agentKind: AgentKind | undefined = agent as AgentKind | undefined;
      const targetAgent = agentKind ?? detected.kind;
      const result = await integrate(projectRoot, targetAgent, dryRun ?? false);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            detectedAgent: detected.name,
            detectedKind: detected.kind,
            integratedAs: result.agent,
            filesCreated: result.filesCreated,
            summary: result.summary,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_watch ─────────────────────────────────────────────
server.tool(
  'docsync_watch',
  'Return the list of paths DocSync would watch. The actual file watcher runs via the CLI (`docsync watch`), not through MCP. Use docsync_refresh for lightweight polling instead.',
  async () => {
    try {
      const watchPaths: string[] = [];
      for (const dir of config.code_dirs) {
        const p = path.join(projectRoot, dir);
        if (fs.existsSync(p)) watchPaths.push(dir);
      }
      for (const dir of config.doc_dirs) {
        const p = path.join(projectRoot, dir);
        if (fs.existsSync(p)) watchPaths.push(dir);
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            watching: true,
            paths: watchPaths,
            hint: 'For persistent file watching, run `docsync watch` in the CLI. For agent polling, use docsync_refresh periodically.',
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_refresh ────────────────────────────────────────────
server.tool(
  'docsync_refresh',
  'Re-scan the codebase for symbol changes and return new/updated symbols since the last scan. Lightweight alternative to persistent watching — agents should poll this periodically.',
  {
    full: z.boolean().optional().default(false).describe('Also re-scan documentation files and auto-link'),
  },
  async ({ full }) => {
    try {
      const available = await extractor.isAvailable();
      if (!available) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No symbol extractor is available.' }) }],
          isError: true,
        };
      }

      const symbolReport = await scanProject(extractor, db, config, projectRoot, false /* incremental */);

      let docReport: { totalFiles: number; totalSections: number; newDocSections: number; newMappings: number; failedFiles: string[] } | null = null;
      let linkResult: { totalMatched: number; highConfidence: number; mediumConfidence: number; lowConfidence: number } | null = null;

      if (full) {
        const { sections, report } = await scanDocs(config.doc_dirs, projectRoot);
        const ingestResult = ingestDocSections(db, sections);

        docReport = {
          totalFiles: report.totalFiles,
          totalSections: report.totalSections,
          newDocSections: ingestResult.newDocSections,
          newMappings: ingestResult.newMappings,
          failedFiles: report.failedFiles,
        };

        const allSymbols = listSymbols(db);
        linkResult = autoLink(db, allSymbols, sections);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            symbols: symbolReport,
            docs: docReport,
            autoLink: linkResult,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_watch_status ──────────────────────────────────────
server.tool(
  'docsync_watch_status',
  'Get the current status of the file watcher (running, events, errors)',
  async () => {
    try {
      const { getWatchStatus } = await import('./tools/watch.js');
      const status = getWatchStatus();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docsync_health ─────────────────────────────────────────────
server.tool(
  'docsync_health',
  'Comprehensive system health check — database, codegraph, filesystem, doc freshness',
  async () => {
    try {
      const { docsyncHealth } = await import('./tools/health.js');
      const report = await docsyncHealth(db, projectRoot, () => extractor.isAvailable(), DOCSYNC_VERSION);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
        isError: !report.healthy,
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── Start ──────────────────────────────────────────────────────
// Track the highest severity exit code across concurrent shutdown calls.
// If SIGINT (code 0) fires first and then uncaughtException (code 1) fires
// during the 500ms grace period, the crash code must NOT be downgraded to 0.
let shuttingDown = false;
let exitCode = 0;

async function shutdown(code: number = 0): Promise<void> {
  // Escalate to the highest-severity exit code seen across concurrent calls.
  // A crash (code 1) arriving after a clean shutdown signal (code 0) must
  // win, so process supervisors (Docker, systemd, k8s) see the failure.
  if (code > exitCode) exitCode = code;
  if (shuttingDown) return;
  shuttingDown = true;

  console.error('DocSync MCP Server shutting down...');
  try { await codegraph.close(); } catch (err: any) {
    if (DOCSYNC_DEBUG) console.error('DocSync: codegraph.close() failed during shutdown:', err instanceof Error ? err.message : err);
  }
  try { closeAllDbs(); } catch (err: any) {
    console.error('DocSync: closeAllDbs() failed during shutdown — WAL may not have checkpointed:', err instanceof Error ? err.message : err);
  }
  // Use exitCode to let the event loop drain gracefully instead of
  // immediately terminating — gives async cleanup a chance to finish.
  // Exit code reflects the reason for shutdown: 0 for clean termination
  // (SIGINT/SIGTERM), 1 for crashes (uncaughtException/unhandledRejection).
  process.exitCode = exitCode;
  // Force-exit after a short grace period in case something is still pending
  setTimeout(() => { process.exit(exitCode); }, 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
  console.error('DocSync: uncaught exception:', err instanceof Error ? err.message : err);
  if (DOCSYNC_DEBUG && err instanceof Error && err.stack) {
    console.error('DocSync: uncaught exception (debug stack):', err.stack);
  }
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('DocSync: unhandled rejection:', reason instanceof Error ? reason.message : reason);
  if (DOCSYNC_DEBUG && reason instanceof Error && reason.stack) {
    console.error('DocSync: unhandled rejection (debug stack):', reason.stack);
  }
  shutdown(1);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DocSync MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  if (DOCSYNC_DEBUG && err instanceof Error && err.stack) {
    console.error('Fatal error (debug stack):', err.stack);
  }
  shutdown(1).then(() => process.exit(1));
});
