// src/index.ts — DocRel MCP Server entry point
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DOCREL_VERSION } from './version.js';
import { getDb, closeDb, closeAllDbs } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { loadConfig } from './utils/config.js';
import type { DocRelConfig } from './utils/config.js';
import { CodegraphClient } from './codegraph/client.js';
import { CodegraphExtractor } from './extractors/codegraph.js';
import { BuiltinExtractor } from './extractors/builtin.js';
import type { SymbolExtractor } from './extractors/interface.js';
import { docrelStatus } from './tools/status.js';
import { docrelCheck } from './tools/check.js';
import { docrelImpact } from './tools/impact.js';
import { syncSymbol, syncAllStale } from './sync/engine.js';
import { docrelLink } from './tools/link.js';
import { docrelDiff } from './tools/diff.js';
import { scanProject } from './discovery/scanner.js';
import { scanDocs } from './discovery/doc-scanner.js';
import { autoLink } from './discovery/auto-linker.js';
import { upsertDocSection } from './db/docs.js';
import { createMapping } from './db/mappings.js';
import { listSymbols } from './db/symbols.js';
import { docSectionId, contentHash } from './utils/hash.js';
import { detectAgent } from './agents/detector.js';
import type { AgentKind } from './agents/detector.js';
import { integrate } from './agents/integrate.js';

const DOCREL_DEBUG = process.env.DOCREL_DEBUG === '1' || process.env.DOCREL_DEBUG === 'true';

/** Sanitize an error for MCP client responses. Logs the full error to stderr
 *  and returns a generic message that does not disclose internal paths or details. */
function sanitizeError(err: unknown): string {
  console.error('DocRel MCP tool error:', err instanceof Error ? err.message : err);
  if (DOCREL_DEBUG && err instanceof Error && err.stack) {
    console.error('DocRel MCP tool error (debug stack):', err.stack);
  }
  return 'Internal error — check server logs.';
}

const projectRoot = process.env.DOCREL_PROJECT_ROOT ?? process.cwd();

// When DOCREL_PROJECT_ROOT is not set, verify .docrel/config.yaml exists in CWD.
// If it does not, the MCP server will initialize against the wrong directory
// (silently creating a DB in a random location).
if (!process.env.DOCREL_PROJECT_ROOT) {
  if (!fs.existsSync(path.join(projectRoot, '.docrel', 'config.yaml'))) {
    console.error('DocRel: DOCREL_PROJECT_ROOT not set and .docrel/config.yaml not found in CWD.');
    console.error('Set DOCREL_PROJECT_ROOT or run from the project root directory.');
    process.exit(1);
  }
}

let config: DocRelConfig;
let db: ReturnType<typeof getDb>;
let extractor: SymbolExtractor;
let codegraph: CodegraphClient;

try {
  config = loadConfig(projectRoot);
  db = getDb(projectRoot);
  runMigrations(db);
  codegraph = new CodegraphClient(config.codegraph?.command);
  const codegraphExtractor = new CodegraphExtractor(codegraph);
  const builtinExtractor = new BuiltinExtractor();
  // Try codegraph; fall back to builtin regex-based extraction
  extractor = (await codegraphExtractor.isAvailable()) ? codegraphExtractor : builtinExtractor;
} catch (err: any) {
  console.error('Failed to initialize DocRel:', err.message);
  process.exit(1);
}

const server = new McpServer({
  name: 'docrel',
  version: DOCREL_VERSION,
});

// ── docrel_status ──────────────────────────────────────────────
server.tool(
  'docrel_status',
  'Get the overall health dashboard of code-documentation synchronization',
  async () => {
    try {
      const status = docrelStatus(db);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docrel_check ───────────────────────────────────────────────
server.tool(
  'docrel_check',
  'Check for stale documentation. Use strict=true to fail on any stale docs.',
  {
    strict: z.boolean().optional().default(false),
    file: z.string().optional().describe('Check only a specific file'),
  },
  async ({ strict, file }) => {
    try {
      const report = docrelCheck(db, strict);
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

// ── docrel_impact ──────────────────────────────────────────────
server.tool(
  'docrel_impact',
  'Analyze which documentation sections are affected by code changes',
  {
    paths: z.array(z.string()).describe('List of changed file paths'),
  },
  async ({ paths }) => {
    try {
      const impact = docrelImpact(db, paths);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(impact, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docrel_sync ────────────────────────────────────────────────
server.tool(
  'docrel_sync',
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

// ── docrel_sync_all ────────────────────────────────────────────
server.tool(
  'docrel_sync_all',
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

// ── docrel_link ────────────────────────────────────────────────
server.tool(
  'docrel_link',
  'Manage a mapping between a code symbol and a documentation section (create, update confidence, or delete)',
  {
    action: z.enum(['create', 'delete']),
    symbol_id: z.string(),
    doc_id: z.string(),
    rel_type: z.enum(['describes', 'references', 'generates', 'contracts']),
    confidence: z.number().min(0).max(1).optional().describe('Confidence 0.0-1.0. Required for update, optional for create (defaults to 1.0).'),
  },
  async ({ action, symbol_id, doc_id, rel_type }) => {
    try {
      const result = docrelLink(db, { action, symbol_id, doc_id, rel_type });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docrel_confirm ─────────────────────────────────────────────
server.tool(
  'docrel_confirm',
  'Confirm a low-confidence mapping as correct — sets confidence to 1.0 (human/AI verified)',
  {
    symbol_id: z.string(),
    doc_id: z.string(),
    rel_type: z.enum(['describes', 'references', 'generates', 'contracts']).optional().default('describes'),
  },
  async ({ symbol_id, doc_id, rel_type }) => {
    try {
      const { docrelConfirm } = await import('./tools/link.js');
      const result = docrelConfirm(db, symbol_id, doc_id, rel_type);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docrel_diff ────────────────────────────────────────────────
server.tool(
  'docrel_diff',
  'Show the diff of changes for a symbol and its linked documentation',
  {
    symbol_id: z.string().describe('Stable symbol ID'),
  },
  async ({ symbol_id }) => {
    try {
      const diff = docrelDiff(db, symbol_id);
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

// ── docrel_scan ────────────────────────────────────────────────
server.tool(
  'docrel_scan',
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

      const symbolReport = await scanProject(extractor, db, config);

      let docReport: { totalFiles: number; totalSections: number; newDocSections: number; newMappings: number; failedFiles: string[] } | null = null;
      let linkResult: { totalMatched: number; highConfidence: number; mediumConfidence: number; lowConfidence: number } | null = null;

      if (docs) {
        const { sections, report } = await scanDocs(config.doc_dirs, projectRoot);
        let newDocs = 0;
        let newMappings = 0;

        for (const section of sections) {
          const id = docSectionId(section.file, section.anchor);
          if (!id) continue;
          const hash = contentHash(section.content);
          const existing = db.prepare('SELECT id FROM doc_sections WHERE id = ?').get(id) as { id: string } | undefined;
          upsertDocSection(db, { id, file: section.file, anchor: section.anchor, content_hash: hash, doc_type: 'standalone' });
          if (!existing) newDocs++;
          for (const ref of section.codeRefs) {
            const cleanName = ref.symbolName.replace(/\(.*\)$/, '');
            const matched = db.prepare('SELECT id FROM symbols WHERE name = ? OR name = ? LIMIT 1').get(cleanName, ref.symbolName) as { id: string } | undefined;
            if (matched) {
              try {
                createMapping(db, { symbol_id: matched.id, doc_id: id, rel_type: 'describes', review_status: 'auto' });
                newMappings++;
              } catch { /* skip duplicates */ }
            }
          }
        }

        docReport = {
          totalFiles: report.totalFiles,
          totalSections: report.totalSections,
          newDocSections: newDocs,
          newMappings,
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

// ── docrel_review ──────────────────────────────────────────────
server.tool(
  'docrel_review',
  'Audit code-doc mappings: find unlinked symbols, orphaned sections, implied references, low-confidence mappings',
  {
    format: z.enum(['json', 'markdown']).optional().default('markdown').describe('Output format'),
  },
  async ({ format }) => {
    try {
      const { docrelReview, formatReview } = await import('./tools/review.js');
      const report = docrelReview(db, projectRoot);
      const text = format === 'json' ? JSON.stringify(report, null, 2) : formatReview(report);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docrel_integrate ───────────────────────────────────────────
server.tool(
  'docrel_integrate',
  'Generate agent integration configs so DocRel is available in your coding agent (Claude Code, OpenCode, Oh My Pi, etc.)',
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

// ── docrel_watch ─────────────────────────────────────────────
server.tool(
  'docrel_watch',
  'Return the list of paths DocRel would watch. The actual file watcher runs via the CLI (`docrel watch`), not through MCP. Use docrel_refresh for lightweight polling instead.',
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
            hint: 'For persistent file watching, run `docrel watch` in the CLI. For agent polling, use docrel_refresh periodically.',
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── docrel_refresh ────────────────────────────────────────────
server.tool(
  'docrel_refresh',
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

      const symbolReport = await scanProject(extractor, db, config);

      let docReport: { totalFiles: number; totalSections: number; newDocSections: number; newMappings: number; failedFiles: string[] } | null = null;
      let linkResult: { totalMatched: number; highConfidence: number; mediumConfidence: number; lowConfidence: number } | null = null;

      if (full) {
        const { sections, report } = await scanDocs(config.doc_dirs, projectRoot);
        let newDocs = 0;
        let newMappings = 0;

        for (const section of sections) {
          const id = docSectionId(section.file, section.anchor);
          if (!id) continue;
          const hash = contentHash(section.content);
          const existing = db.prepare('SELECT id FROM doc_sections WHERE id = ?').get(id) as { id: string } | undefined;
          upsertDocSection(db, { id, file: section.file, anchor: section.anchor, content_hash: hash, doc_type: 'standalone' });
          if (!existing) newDocs++;
          for (const ref of section.codeRefs) {
            const cleanName = ref.symbolName.replace(/\(.*\)$/, '');
            const matched = db.prepare('SELECT id FROM symbols WHERE name = ? OR name = ? LIMIT 1').get(cleanName, ref.symbolName) as { id: string } | undefined;
            if (matched) {
              try {
                createMapping(db, { symbol_id: matched.id, doc_id: id, rel_type: 'describes', review_status: 'auto' });
                newMappings++;
              } catch { /* skip duplicates */ }
            }
          }
        }

        docReport = {
          totalFiles: report.totalFiles,
          totalSections: report.totalSections,
          newDocSections: newDocs,
          newMappings,
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

  console.error('DocRel MCP Server shutting down...');
  try { await codegraph.close(); } catch {}
  try { closeAllDbs(); } catch {}
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
  console.error('DocRel: uncaught exception:', err instanceof Error ? err.message : err);
  if (DOCREL_DEBUG && err instanceof Error && err.stack) {
    console.error('DocRel: uncaught exception (debug stack):', err.stack);
  }
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('DocRel: unhandled rejection:', reason instanceof Error ? reason.message : reason);
  if (DOCREL_DEBUG && reason instanceof Error && reason.stack) {
    console.error('DocRel: unhandled rejection (debug stack):', reason.stack);
  }
  shutdown(1);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DocRel MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  if (DOCREL_DEBUG && err instanceof Error && err.stack) {
    console.error('Fatal error (debug stack):', err.stack);
  }
  shutdown(1).then(() => process.exit(1));
});
