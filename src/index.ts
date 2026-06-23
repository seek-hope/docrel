// src/index.ts — DocRel MCP Server entry point
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DOCREL_VERSION } from './version.js';
import { getDb, closeDb, closeAllDbs } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { loadConfig } from './utils/config.js';
import type { DocRelConfig } from './utils/config.js';
import { CodegraphClient } from './codegraph/client.js';
import { docrelStatus } from './tools/status.js';
import { docrelCheck } from './tools/check.js';
import { docrelImpact } from './tools/impact.js';
import { syncSymbol } from './sync/engine.js';
import { docrelLink } from './tools/link.js';
import { docrelDiff } from './tools/diff.js';

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

let config: DocRelConfig;
let db: ReturnType<typeof getDb>;
let codegraph: CodegraphClient;

try {
  config = loadConfig(projectRoot);
  db = getDb(projectRoot);
  runMigrations(db);
  codegraph = new CodegraphClient(config.codegraph?.command);
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              passed: report.passed && (strict ? filtered.length === 0 : true),
              staleDocs: filtered,
              summary: `${filtered.length} stale doc(s) in ${file}`,
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
      const result = await syncSymbol(db, config, symbol_id, projectRoot);
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
  'Create or delete a mapping between a code symbol and a documentation section',
  {
    action: z.enum(['create', 'delete']),
    symbol_id: z.string(),
    doc_id: z.string(),
    rel_type: z.enum(['describes', 'references', 'generates', 'contracts']),
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
      if (!diff) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Symbol not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(diff, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) }], isError: true };
    }
  },
);

// ── Start ──────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(code: number = 0): Promise<void> {
  // Set the flag FIRST to prevent re-entrancy from uncaughtException firing
  // concurrently with unhandledRejection (which Node can deliver synchronously
  // during exception handling).
  if (shuttingDown) return;
  shuttingDown = true;

  console.error('DocRel MCP Server shutting down...');
  try { await codegraph.close(); } catch {}
  try { closeAllDbs(); } catch {}
  // Use exitCode to let the event loop drain gracefully instead of
  // immediately terminating — gives async cleanup a chance to finish.
  // Exit code reflects the reason for shutdown: 0 for clean termination
  // (SIGINT/SIGTERM), 1 for crashes (uncaughtException/unhandledRejection).
  process.exitCode = code;
  // Force-exit after a short grace period in case something is still pending
  setTimeout(() => { process.exit(code); }, 500).unref();
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
  process.exit(1);
});
