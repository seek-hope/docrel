/**
 * In-process MCP server tests: build the real server via createDocrelayServer
 * and drive it over an InMemoryTransport with the official SDK client.
 * Covers the tool-registration wiring in src/index.ts that subprocess tests
 * cannot reach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDocrelayServer, type DocrelayServerDeps } from '../../src/index.js';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { loadConfig } from '../../src/utils/config.js';
import { BuiltinExtractor } from '../../src/extractors/builtin.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
import { docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content[0]?.type).toBe('text');
  return content[0].text ?? '';
}

describe('MCP server (in-process)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-mcp-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    // health checks require an initialized .docrelay/ with a config file
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.docrelay', 'config.yaml'),
      'version: 1\nproject: test\ndoc_dirs:\n  - docs\ncode_dirs:\n  - src\n',
      'utf-8',
    );
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

    db = getDb(tmpDir);
    runMigrations(db);
    const deps: DocrelayServerDeps = {
      db,
      config: loadConfig(tmpDir),
      extractor: new BuiltinExtractor(),
      codegraph: {} as CodegraphClient,
      projectRoot: tmpDir,
    };
    const server = createDocrelayServer(deps);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);
    cleanup = async () => { await client.close(); await server.close(); };

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await cleanup();
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists the registered tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'docrelay_status', 'docrelay_check', 'docrelay_impact', 'docrelay_sync',
      'docrelay_sync_all', 'docrelay_link', 'docrelay_confirm', 'docrelay_reject',
      'docrelay_diff', 'docrelay_history', 'docrelay_scan', 'docrelay_review', 'docrelay_integrate',
      'docrelay_watch', 'docrelay_refresh', 'docrelay_watch_status', 'docrelay_health',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('status and check work on an empty project', async () => {
    const status = JSON.parse(textOf(await client.callTool({ name: 'docrelay_status', arguments: {} }))) as
      { totalSymbols: number; totalDocs: number };
    expect(status.totalSymbols).toBe(0);
    expect(status.totalDocs).toBe(0);

    const check = JSON.parse(textOf(await client.callTool({ name: 'docrelay_check', arguments: {} }))) as
      { passed: boolean };
    expect(check.passed).toBe(true);
  });

  it('scan discovers symbols and docs, then status reflects them', async () => {
    const scan = JSON.parse(textOf(await client.callTool({ name: 'docrelay_scan', arguments: { docs: true } }))) as
      { symbols: { totalSymbols: number }; docs: { totalSections: number } };
    expect(scan.symbols.totalSymbols).toBeGreaterThanOrEqual(1);
    expect(scan.docs.totalSections).toBeGreaterThanOrEqual(1);

    const status = JSON.parse(textOf(await client.callTool({ name: 'docrelay_status', arguments: {} }))) as
      { totalSymbols: number; totalDocs: number };
    expect(status.totalSymbols).toBeGreaterThanOrEqual(1);
    expect(status.totalDocs).toBeGreaterThanOrEqual(1);
  });

  it('check file-filter recomputes passed from the filtered set', async () => {
    await client.callTool({ name: 'docrelay_scan', arguments: { docs: true } });
    db.prepare("UPDATE doc_sections SET status = 'stale'").run();

    const filtered = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_check',
      arguments: { strict: true, file: 'docs/api.md' },
    }))) as { passed: boolean; staleDocs: unknown[] };
    expect(filtered.passed).toBe(false);
    // api.md yields two sections (the '# API' preamble + '## login').
    expect(filtered.staleDocs).toHaveLength(2);

    const miss = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_check',
      arguments: { strict: true, file: 'docs/other.md' },
    }))) as { passed: boolean; summary: string };
    expect(miss.passed).toBe(true);
    expect(miss.summary).toContain('in sync');
  });

  it('link → review → confirm round-trip through tool calls', async () => {
    await client.callTool({ name: 'docrelay_scan', arguments: { docs: true } });
    const sym = db.prepare("SELECT id FROM symbols WHERE name = 'login'").get() as { id: string };
    const docId = docSectionId('docs/api.md', 'login');
    // scan's auto-linker may already have linked them; a duplicate create is a no-op update.
    const link = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_link',
      arguments: { action: 'create', symbol_id: sym.id, doc_id: docId, rel_type: 'describes' },
    }))) as { action: string };
    expect(['created', 'updated', 'exists', 'already_exists']).toContain(link.action);

    const review = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_review', arguments: { format: 'json' },
    }))) as { unreviewedMappings: unknown[] };
    expect(review.unreviewedMappings.length).toBeGreaterThanOrEqual(1);

    const confirm = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_confirm',
      arguments: { symbol_id: sym.id, doc_id: docId, rel_type: 'describes' },
    }))) as { review_status?: string; status?: string };
    expect(JSON.stringify(confirm)).toContain('confirmed');

    // The confirm call is recorded in review history, attributed to the MCP actor.
    const history = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_history', arguments: { symbol_id: sym.id },
    }))) as Array<{ action: string; actor: string; symbol_name: string | null; doc_file: string | null }>;
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]).toMatchObject({ action: 'confirmed', actor: 'mcp' });
    expect(history[0].symbol_name).toBe('login');
    expect(history[0].doc_file).toBe('docs/api.md');
  });

  it('history rejects an invalid limit and returns an empty list on a fresh project', async () => {
    const empty = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_history', arguments: {},
    }))) as unknown[];
    expect(empty).toEqual([]);

    const bad = await client.callTool({ name: 'docrelay_history', arguments: { limit: 0 } });
    expect(bad.isError).toBe(true);
  });

  it('impact, diff (not-found), watch, watch_status, refresh, and health respond', async () => {
    await client.callTool({ name: 'docrelay_scan', arguments: { docs: true } });

    const impact = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_impact', arguments: { paths: ['src/auth.ts'] },
    }))) as Record<string, unknown>;
    expect(impact).toBeTruthy();

    const diff = await client.callTool({ name: 'docrelay_diff', arguments: { symbol_id: 'nope' } });
    expect(diff.isError).toBe(true);
    expect(textOf(diff)).toContain('not found');

    const watch = JSON.parse(textOf(await client.callTool({ name: 'docrelay_watch', arguments: {} }))) as
      { watching: boolean; paths: string[] };
    expect(watch.watching).toBe(true);
    expect(watch.paths).toEqual(expect.arrayContaining(['src', 'docs']));

    const watchStatus = JSON.parse(textOf(await client.callTool({ name: 'docrelay_watch_status', arguments: {} }))) as
      { running: boolean };
    expect(watchStatus.running).toBe(false);

    // refresh is incremental: after the full scan above, nothing changed,
    // so it reports zero new/updated symbols (not the project total).
    const refresh = JSON.parse(textOf(await client.callTool({ name: 'docrelay_refresh', arguments: {} }))) as
      { symbols: { totalSymbols: number } };
    expect(refresh.symbols.totalSymbols).toBe(0);

    const health = JSON.parse(textOf(await client.callTool({ name: 'docrelay_health', arguments: {} }))) as
      { healthy: boolean };
    expect(health.healthy).toBe(true);
  });

  it('sync reports an error for an unknown symbol without crashing the server', async () => {
    const result = JSON.parse(textOf(await client.callTool({
      name: 'docrelay_sync', arguments: { symbol_id: 'ghost' },
    }))) as { errors: string[] };
    expect(result.errors[0]).toContain('Symbol not found');

    // Server is still alive and responsive.
    const status = JSON.parse(textOf(await client.callTool({ name: 'docrelay_status', arguments: {} })));
    expect(status).toBeTruthy();
  });
});
