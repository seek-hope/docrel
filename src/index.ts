// src/index.ts — DocRel MCP Server entry point
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from './db/connection.js';
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
  version: '0.1.0',
});

// ── docrel_status ──────────────────────────────────────────────
server.tool(
  'docrel_status',
  'Get the overall health dashboard of code-documentation synchronization',
  async () => {
    const status = docrelStatus(db);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
    };
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
    const report = docrelCheck(db, strict);
    if (file) {
      const filtered = report.staleDocs.filter((d) => d.file === file);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            passed: filtered.length === 0,
            staleDocs: filtered,
            summary: `${filtered.length} stale doc(s) in ${file}`,
          }, null, 2),
        }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
    };
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
    const impact = docrelImpact(db, paths);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(impact, null, 2) }],
    };
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
    const result = await syncSymbol(db, codegraph, config, symbol_id, projectRoot);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
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
    const result = docrelLink(db, { action, symbol_id, doc_id, rel_type });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
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
    const diff = docrelDiff(db, symbol_id);
    if (!diff) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Symbol not found' }) }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(diff, null, 2) }],
    };
  },
);

// ── Start ──────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DocRel MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
