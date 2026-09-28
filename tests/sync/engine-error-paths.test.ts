/**
 * Error-path coverage for syncSymbol (engine.ts): dangling mappings, mark*
 * helper failures via a fault-injecting db proxy, standalone surgical-
 * replacement outcomes (dedup, genuine failures, hash accounting, mtime
 * checks), unknown doc_types, and the sanitized catastrophic handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { findSectionContent } from '../../src/sync/standalone.js';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeConfig(strategies: Partial<DocRelayConfig['strategies']> = {}): DocRelayConfig {
  return {
    version: 1,
    project: 'test',
    doc_dirs: ['docs'],
    code_dirs: ['src'],
    strategies: {
      inline: 'mark_stale',
      standalone: 'mark_stale',
      generated: 'mark_stale',
      architecture: 'mark_stale',
      ...strategies,
    },
  };
}

/** A db wrapper whose prepare() fails for statements containing `match`:
 *  returns zero-change results (mark* helpers see "doc deleted concurrently")
 *  or throws outright (catastrophic paths). Everything else delegates. */
function proxyDb(
  db: Database.Database,
  match: string,
  opts: { throwWith?: Error } = {},
): Database.Database {
  return {
    prepare(sql: string) {
      if (sql.includes(match)) {
        if (opts.throwWith) throw opts.throwWith;
        return {
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
          all: () => [],
          get: () => undefined,
        };
      }
      return db.prepare(sql);
    },
  } as unknown as Database.Database;
}

describe('syncSymbol error paths', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const sym = symbolId('typescript', 'src/auth.ts::login', 'function');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-engerr-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSymbol(location = 'src/auth.ts:4', raw?: string) {
    upsertSymbol(db, {
      id: sym,
      name: 'login',
      kind: 'function',
      location,
      ...(raw ? { raw_signature: raw } : {}),
    });
  }

  function linkDoc(
    file: string,
    anchor: string,
    docType: 'inline' | 'standalone' | 'generated' | 'architecture',
    status: 'in_sync' | 'stale' = 'in_sync',
  ): string {
    const id = docSectionId(file, anchor);
    upsertDocSection(db, { id, file, anchor, doc_type: docType, status });
    createMapping(db, { symbol_id: sym, doc_id: id, rel_type: 'describes' });
    return id;
  }

  /** Working inline auto_update setup: docstring extractable, signature
   *  extractable, updateInlineDoc expected to succeed. */
  function seedInlineHappy() {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'auth.ts'),
      '/**\n * Docs.\n */\nexport function login(user: string): boolean {\n  return true;\n}\n',
      'utf-8',
    );
    seedSymbol('src/auth.ts:4', 'export function login(user: string, pass: string): boolean {');
    linkDoc('src/auth.ts', 'login', 'inline', 'stale');
  }

  /** Working standalone auto_update setup: docs/api.md has an '## auth'
   *  section documenting `oldSigInDoc`; the source file holds the new
   *  signature; optional changelog old_sig drives the surgical pairs. */
  function seedStandaloneHappy(opts: { oldSigInDoc?: string; changelogOld?: string; raw?: string } = {}) {
    const oldSig = opts.oldSigInDoc ?? 'login(user: string): boolean';
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), `## auth\n\n\`${oldSig}\`\n`, 'utf-8');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'auth.ts'),
      'export function login(user: string, pass: string): boolean {\n  return true;\n}\n',
      'utf-8',
    );
    seedSymbol('src/auth.ts:1', opts.raw ?? 'export function login(user: string, pass: string): boolean {');
    if (opts.changelogOld) {
      db.prepare(
        "INSERT INTO changelog (symbol_id, change_type, old_sig) VALUES (?, 'signature_changed', ?)",
      ).run(sym, opts.changelogOld);
    }
    linkDoc('docs/api.md', 'auth', 'standalone', 'stale');
  }

  it('skips mappings whose doc section no longer exists', async () => {
    seedSymbol();
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO mappings (symbol_id, doc_id, rel_type) VALUES (?, ?, 'describes')").run(sym, 'deleted-doc-id');
    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.docsChecked).toHaveLength(0);
    expect(result.docsStaled).toHaveLength(0);
    expect(result.docsUpdated).toHaveLength(0);
  });

  it('reports when a doc with no configured strategy cannot be marked stale', async () => {
    seedSymbol();
    linkDoc('docs/api.md', 'auth', 'standalone');
    const cfg = makeConfig();
    delete (cfg.strategies as Record<string, unknown>).standalone;
    const result = await syncSymbol(proxyDb(db, "SET status = 'stale'"), cfg, sym, tmpDir);
    expect(result.errors.some((e) => e.includes('Failed to mark doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports when an inline doc cannot be marked stale', async () => {
    seedSymbol();
    linkDoc('src/auth.ts', 'login', 'inline');
    const result = await syncSymbol(proxyDb(db, "SET status = 'stale'"), makeConfig(), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('Failed to mark inline doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports when a synced inline doc cannot be marked as such', async () => {
    seedInlineHappy();
    const result = await syncSymbol(
      proxyDb(db, "SET status = 'in_sync'"),
      makeConfig({ inline: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('Failed to mark inline doc') && e.includes('as synced'))).toBe(true);
  });

  it('reports when the inline doc update itself fails', async () => {
    // The old docstring text appears twice, so updateInlineDoc's occurrence
    // guards refuse the replacement.
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'auth.ts'),
      '/**\n * Docs.\n */\nexport function login(user: string): boolean {\n  return true;\n}\n\n/**\n * Docs.\n */\nexport function other(): void {}\n',
      'utf-8',
    );
    seedSymbol('src/auth.ts:4', 'export function login(user: string, pass: string): boolean {');
    linkDoc('src/auth.ts', 'login', 'inline', 'stale');
    const result = await syncSymbol(db, makeConfig({ inline: 'auto_update' }), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('Failed to update inline doc for login'))).toBe(true);
  });

  it('reports a race when the standalone hash update fails after a surgical rewrite', async () => {
    seedStandaloneHappy({ changelogOld: 'login(user: string): boolean' });
    const result = await syncSymbol(
      proxyDb(db, 'SET content_hash'),
      makeConfig({ standalone: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('race condition'))).toBe(true);
  });

  it('deduplicates identical old-signature candidates', async () => {
    // raw_signature matches the changelog old_sig exactly — the second
    // pushPair must not add a duplicate pair.
    seedStandaloneHappy({
      changelogOld: 'login(user: string): boolean',
      raw: 'login(user: string): boolean',
    });
    const result = await syncSymbol(db, makeConfig({ standalone: 'auto_update' }), sym, tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.docsUpdated).toContain('docs/api.md');
  });

  it('surfaces genuine write failures from the surgical rewrite', async () => {
    seedStandaloneHappy({ changelogOld: 'login(user: string): boolean' });
    // .docrelay as a regular file makes the atomic-write temp mkdir fail.
    fs.writeFileSync(path.join(tmpDir, '.docrelay'), 'not a directory', 'utf-8');
    const result = await syncSymbol(db, makeConfig({ standalone: 'auto_update' }), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('Cannot auto-rewrite standalone doc'))).toBe(true);
    expect(result.docsStaled).toContain('docs/api.md');
  });

  it('reports when a genuinely-failed standalone doc cannot be marked stale', async () => {
    seedStandaloneHappy({ changelogOld: 'login(user: string): boolean' });
    fs.writeFileSync(path.join(tmpDir, '.docrelay'), 'not a directory', 'utf-8');
    const result = await syncSymbol(
      proxyDb(db, "SET status = 'stale'"),
      makeConfig({ standalone: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('Failed to mark standalone doc') && e.includes('as stale'))).toBe(true);
  });

  /** Doc already shows the NEW signature (agent rewrote it); the changelog
   *  old text is absent, so surgical replacement is skipped and only the
   *  hash accounting / mtime-check paths run. */
  function seedAgentRewritten(opts: { pinHash?: boolean } = {}) {
    seedStandaloneHappy({
      oldSigInDoc: 'login(user: string, pass: string): boolean',
      changelogOld: 'login(old: number): void',
      raw: 'login(old: number): void',
    });
    if (!opts.pinHash) return;
    const section = findSectionContent('docs/api.md', 'auth', tmpDir)!;
    db.prepare('UPDATE doc_sections SET content_hash = ? WHERE id = ?').run(
      contentHash(section),
      docSectionId('docs/api.md', 'auth'),
    );
  }

  it('reports a race when the agent-rewritten hash accounting fails', async () => {
    // content_hash left unpinned, so the recomputed section hash differs
    // and markDocRelayedWithHash runs — which the proxy forces to fail.
    seedAgentRewritten();
    const result = await syncSymbol(
      proxyDb(db, 'SET content_hash'),
      makeConfig({ standalone: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('race condition'))).toBe(true);
  });

  it('warns when the mtime check cannot stat the doc file', async () => {
    seedAgentRewritten({ pinHash: true });
    const realStat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      if (String(p).endsWith('api.md')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realStat(p);
    });
    const result = await syncSymbol(db, makeConfig({ standalone: 'auto_update' }), sym, tmpDir);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cannot stat'));
    expect(result.docsChecked).toHaveLength(0);
  });

  it('reports when an agent-rewritten standalone doc cannot be marked synced', async () => {
    seedAgentRewritten({ pinHash: true });
    // Make the file mtime clearly newer than the doc's updated_at.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(tmpDir, 'docs', 'api.md'), future, future);
    const result = await syncSymbol(
      proxyDb(db, "SET status = 'in_sync'"),
      makeConfig({ standalone: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('Failed to mark standalone doc') && e.includes('as synced'))).toBe(true);
  });

  it('reports when a restructured standalone doc cannot be marked stale', async () => {
    seedStandaloneHappy();
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '## other\n\nNothing here.\n', 'utf-8');
    const result = await syncSymbol(
      proxyDb(db, "SET status = 'stale'"),
      makeConfig({ standalone: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('Cannot find section'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Failed to mark standalone doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports when a mark_stale standalone doc cannot be marked', async () => {
    seedStandaloneHappy();
    const result = await syncSymbol(
      proxyDb(db, "SET status = 'stale'"),
      makeConfig({ standalone: 'mark_stale' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('Failed to mark standalone doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports when a generator-less generated doc cannot be marked stale', async () => {
    seedSymbol();
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '## auth\n\nDocs.\n', 'utf-8');
    linkDoc('docs/api.md', 'auth', 'generated');
    const result = await syncSymbol(
      proxyDb(db, "SET status = 'stale'"),
      makeConfig({ generated: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('No generator found'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Failed to mark generated doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports when a mark_stale generated doc cannot be marked', async () => {
    seedSymbol();
    linkDoc('docs/api.md', 'auth', 'generated');
    const result = await syncSymbol(proxyDb(db, "SET status = 'stale'"), makeConfig(), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('Failed to mark generated doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports when an architecture doc cannot be marked stale', async () => {
    seedSymbol();
    linkDoc('docs/arch.md', 'overview', 'architecture');
    const result = await syncSymbol(proxyDb(db, "SET status = 'stale'"), makeConfig(), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('Failed to mark architecture doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports an unknown doc_type from a pre-existing DB row', async () => {
    seedSymbol();
    const id = linkDoc('docs/api.md', 'auth', 'standalone');
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE doc_sections SET doc_type = 'mystery' WHERE id = ?").run(id);
    const cfg = makeConfig();
    (cfg.strategies as Record<string, unknown>).mystery = 'mark_stale';
    const result = await syncSymbol(db, cfg, sym, tmpDir);
    expect(result.errors.some((e) => e.includes("Unknown doc_type 'mystery'"))).toBe(true);
  });

  it('sanitizes absolute paths from per-doc sync errors', async () => {
    // doc.file deliberately differs from the symbol location so the engine
    // runs the file-mismatch repair UPDATE — which the proxy makes throw.
    upsertSymbol(db, { id: sym, name: 'login', kind: 'function', location: 'src/auth.ts:4' });
    linkDoc('src/old.ts', 'login', 'inline');
    const throwing = proxyDb(db, 'UPDATE doc_sections SET file', {
      throwWith: new Error('write failed at /very/long/absolute/path/segment/here'),
    });
    const result = await syncSymbol(throwing, makeConfig(), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('internal error — check server logs'))).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Error syncing doc'),
      expect.not.stringContaining('/very/long'),
    );
  });

  it('sanitizes catastrophic failures before the per-doc loop', async () => {
    seedSymbol();
    const throwing = proxyDb(db, 'FROM mappings', {
      throwWith: new Error('database /very/long/absolute/path/segment/here is locked'),
    });
    const result = await syncSymbol(throwing, makeConfig(), sym, tmpDir);
    expect(result.errors).toEqual(['Catastrophic sync error: internal error — check server logs']);
  });

  it('reports inline sync for a location without a line number', async () => {
    upsertSymbol(db, { id: sym, name: 'login', kind: 'function', location: 'no-colon-here' });
    linkDoc('src/auth.ts', 'login', 'inline');
    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('invalid or missing source file location'))).toBe(true);
  });

  it('marks a mark_stale generated doc as stale', async () => {
    // Success counterpart of the proxy-failure test above (engine.ts:466).
    seedSymbol();
    linkDoc('docs/api.md', 'auth', 'generated');
    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);
    expect(result.docsStaled).toContain('docs/api.md');
    expect(result.errors).toHaveLength(0);
  });

  it('reports when a standalone doc with unrecoverable old-signature text cannot be marked stale', async () => {
    // raw_signature already equals the on-disk signature and there is no
    // changelog history, so no surgical candidate pairs exist
    // (surgicalAttempted === false → engine.ts:330 branch). The proxy then
    // fails markDocStale, hitting the 338 error push — whose message text is
    // identical to the genuineFailure branch's, so also assert the
    // branch-specific "Cannot determine old signature text" error.
    seedStandaloneHappy();
    const result = await syncSymbol(
      proxyDb(db, "SET status = 'stale'"),
      makeConfig({ standalone: 'auto_update' }),
      sym,
      tmpDir,
    );
    expect(result.errors.some((e) => e.includes('Cannot determine old signature text'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Failed to mark standalone doc') && e.includes('as stale'))).toBe(true);
  });

  it('reports inline sync for a non-numeric line number', async () => {
    upsertSymbol(db, { id: sym, name: 'login', kind: 'function', location: 'src/auth.ts:abc' });
    linkDoc('src/auth.ts', 'login', 'inline');
    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);
    expect(result.errors.some((e) => e.includes('invalid or missing source file location'))).toBe(true);
  });
});
