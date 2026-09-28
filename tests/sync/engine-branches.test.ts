import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol, syncAllStale } from '../../src/sync/engine.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
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

describe('syncSymbol — strategy branches', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const sym = symbolId('typescript', 'src/auth.ts::login', 'function');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-eng-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: sym, name: 'login', kind: 'function', location: 'src/auth.ts:42' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function linkDoc(file: string, anchor: string, docType: 'inline' | 'standalone' | 'generated' | 'architecture'): string {
    const id = docSectionId(file, anchor);
    upsertDocSection(db, { id, file, anchor, doc_type: docType, status: 'in_sync' });
    createMapping(db, { symbol_id: sym, doc_id: id, rel_type: 'describes' });
    return id;
  }

  it('reports an error for an unknown symbol id', async () => {
    const result = await syncSymbol(db, makeConfig(), 'no-such-symbol', tmpDir);
    expect(result.errors[0]).toContain('Symbol not found: no-such-symbol');
  });

  it('leaves docs untouched when the strategy is ignore', async () => {
    const docId = linkDoc('docs/api.md', 'auth', 'standalone');
    const result = await syncSymbol(db, makeConfig({ standalone: 'ignore' }), sym, tmpDir);

    expect(result.docsStaled).toHaveLength(0);
    expect(result.docsChecked).toHaveLength(0);
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
  });

  it('withholds changes and builds a review proposal for the prompt strategy', async () => {
    const docId = linkDoc('docs/api.md', 'auth', 'standalone');
    const result = await syncSymbol(db, makeConfig({ standalone: 'prompt' }), sym, tmpDir);

    expect(result.requiresReview).toBe(true);
    expect(result.proposedChanges).toHaveLength(1);
    expect(result.proposedChanges[0]).toMatchObject({
      file: 'docs/api.md',
      anchor: 'auth',
      symbolName: 'login',
    });
    expect(result.proposedChanges[0].reason).toContain('login');
    expect(result.docsChecked).toContain('docs/api.md');
    // Prompt strategy never mutates the doc.
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
  });

  it('marks architecture docs stale under any non-ignore strategy', async () => {
    const docId = linkDoc('docs/arch.md', 'overview', 'architecture');
    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);

    expect(result.docsStaled).toContain('docs/arch.md');
    expect(getDocSection(db, docId)!.status).toBe('stale');
  });

  it('marks generated docs stale when no generator is detectable', async () => {
    const docId = linkDoc('docs/api.md', 'gen', 'generated');
    const result = await syncSymbol(db, makeConfig({ generated: 'auto_update' }), sym, tmpDir);

    expect(result.errors.some((e) => e.includes('No generator found'))).toBe(true);
    expect(result.docsStaled).toContain('docs/api.md');
    expect(getDocSection(db, docId)!.status).toBe('stale');
  });

  it('fails standalone auto_update when the section is missing from the file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '## other\n\nnothing here\n', 'utf-8');
    const docId = linkDoc('docs/api.md', 'auth', 'standalone');
    const result = await syncSymbol(db, makeConfig({ standalone: 'auto_update' }), sym, tmpDir);

    expect(result.errors.some((e) => e.includes("Cannot find section 'auth'"))).toBe(true);
    expect(getDocSection(db, docId)!.status).toBe('stale');
  });

  it('fails standalone auto_update when the current signature cannot be read', async () => {
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), '## auth\n\ndocs here\n', 'utf-8');
    const docId = linkDoc('docs/api.md', 'auth', 'standalone');
    // Symbol location file does not exist → current signature cannot be read,
    // and no changelog/raw_signature candidates exist → surgical impossible.
    const result = await syncSymbol(db, makeConfig({ standalone: 'auto_update' }), sym, tmpDir);

    expect(result.errors.some((e) => e.includes('Cannot auto-update standalone doc'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('requires manual/agent rewrite'))).toBe(true);
    expect(getDocSection(db, docId)!.status).toBe('stale');
  });

  it('flips pending changelog rows to applied after a clean sync', async () => {
    linkDoc('docs/api.md', 'auth', 'standalone');
    db.prepare(
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig) VALUES (?, 'signature_changed', 'a', 'b')",
    ).run(sym);

    const result = await syncSymbol(db, makeConfig(), sym, tmpDir);
    expect(result.errors).toHaveLength(0);

    const row = db.prepare('SELECT sync_status AS s FROM changelog WHERE symbol_id = ?').get(sym) as { s: string };
    expect(row.s).toBe('applied');
  });

  it('flips pending changelog rows to failed when errors occurred', async () => {
    // generated + auto_update without a detectable generator → sync error.
    linkDoc('docs/gen.md', 'g', 'generated');
    db.prepare(
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig) VALUES (?, 'signature_changed', 'a', 'b')",
    ).run(sym);

    const result = await syncSymbol(db, makeConfig({ generated: 'auto_update' }), sym, tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);

    const row = db.prepare('SELECT sync_status AS s FROM changelog WHERE symbol_id = ?').get(sym) as { s: string };
    expect(row.s).toBe('failed');
  });
});

describe('syncAllStale', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-synall-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
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

  const fakeCodegraph = {} as CodegraphClient;

  it('returns zero counts when nothing is stale', async () => {
    const out = await syncAllStale(db, fakeCodegraph, makeConfig(), tmpDir);
    expect(out).toEqual({ synced: [], totalStale: 0 });
  });

  it('syncs every symbol linked to a stale doc exactly once', async () => {
    const symA = symbolId('typescript', 'src/a.ts::A', 'function');
    const symB = symbolId('typescript', 'src/b.ts::B', 'function');
    upsertSymbol(db, { id: symA, name: 'A', kind: 'function', location: 'src/a.ts:1' });
    upsertSymbol(db, { id: symB, name: 'B', kind: 'function', location: 'src/b.ts:1' });

    const doc1 = docSectionId('docs/one.md', 'x');
    const doc2 = docSectionId('docs/two.md', 'y');
    upsertDocSection(db, { id: doc1, file: 'docs/one.md', anchor: 'x', doc_type: 'standalone', status: 'stale' });
    upsertDocSection(db, { id: doc2, file: 'docs/two.md', anchor: 'y', doc_type: 'standalone', status: 'stale' });
    // Both stale docs link to A (dedup check), one links to B.
    createMapping(db, { symbol_id: symA, doc_id: doc1, rel_type: 'describes' });
    createMapping(db, { symbol_id: symA, doc_id: doc2, rel_type: 'references' });
    createMapping(db, { symbol_id: symB, doc_id: doc2, rel_type: 'describes' });

    const out = await syncAllStale(db, fakeCodegraph, makeConfig(), tmpDir);

    expect(out.totalStale).toBe(2);
    expect(out.synced).toHaveLength(2); // symA once, symB once
    const ids = out.synced.map((r) => r.symbolId).sort();
    expect(ids).toEqual([symA, symB].sort());
  });

  /** Fixture: one symbol on disk + one stale standalone doc (auto_update) that
   *  forces the signature-extraction path where codegraph would be consulted. */
  const seedAutoUpdateFixture = () => {
    const symA = symbolId('typescript', 'src/a.ts::A', 'function');
    upsertSymbol(db, { id: symA, name: 'A', kind: 'function', location: 'src/a.ts:1' });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'export function A(): number {\n  return 1;\n}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'one.md'), '# Doc\n\n## x\n\nold text\n', 'utf-8');
    const doc1 = docSectionId('docs/one.md', 'x');
    upsertDocSection(db, { id: doc1, file: 'docs/one.md', anchor: 'x', doc_type: 'standalone', status: 'stale' });
    createMapping(db, { symbol_id: symA, doc_id: doc1, rel_type: 'describes' });
    return symA;
  };

  it('probes codegraph availability once per batch and skips per-symbol queries when unavailable', async () => {
    seedAutoUpdateFixture();
    const isAvailable = vi.fn().mockResolvedValue(false);
    const getSymbolSignature = vi.fn();
    const cg = { isAvailable, getSymbolSignature } as unknown as CodegraphClient;

    await syncAllStale(db, cg, makeConfig({ standalone: 'auto_update' }), tmpDir);

    expect(isAvailable).toHaveBeenCalledTimes(1);
    // Unavailable → straight to the regex extractor, zero per-symbol queries
    // (previously every symbol paid a failed spawn + preflight before fallback).
    expect(getSymbolSignature).not.toHaveBeenCalled();
  });

  it('queries codegraph for signatures when the probe reports available', async () => {
    seedAutoUpdateFixture();
    const isAvailable = vi.fn().mockResolvedValue(true);
    const getSymbolSignature = vi.fn().mockResolvedValue(null); // null → regex fallback
    const cg = { isAvailable, getSymbolSignature } as unknown as CodegraphClient;

    await syncAllStale(db, cg, makeConfig({ standalone: 'auto_update' }), tmpDir);

    expect(isAvailable).toHaveBeenCalledTimes(1);
    expect(getSymbolSignature).toHaveBeenCalled();
  });

  it('shares comment-stripped source lines across symbols in the same file', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'shared.ts'),
      'export function A(): number {\n  return 1;\n}\n\nexport function B(): number {\n  return 2;\n}\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(tmpDir, 'docs', 'one.md'), '# Doc\n\n## x\n\nold\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'two.md'), '# Doc\n\n## y\n\nold\n', 'utf-8');
    const symA = symbolId('typescript', 'src/shared.ts::A', 'function');
    const symB = symbolId('typescript', 'src/shared.ts::B', 'function');
    upsertSymbol(db, { id: symA, name: 'A', kind: 'function', location: 'src/shared.ts:1' });
    upsertSymbol(db, { id: symB, name: 'B', kind: 'function', location: 'src/shared.ts:5' });
    const doc1 = docSectionId('docs/one.md', 'x');
    const doc2 = docSectionId('docs/two.md', 'y');
    upsertDocSection(db, { id: doc1, file: 'docs/one.md', anchor: 'x', doc_type: 'standalone', status: 'stale' });
    upsertDocSection(db, { id: doc2, file: 'docs/two.md', anchor: 'y', doc_type: 'standalone', status: 'stale' });
    createMapping(db, { symbol_id: symA, doc_id: doc1, rel_type: 'describes' });
    createMapping(db, { symbol_id: symB, doc_id: doc2, rel_type: 'describes' });

    const cache = new Map<string, string[]>();
    const cfg = makeConfig({ standalone: 'auto_update' });
    await syncSymbol(db, cfg, symA, tmpDir, undefined, cache);
    await syncSymbol(db, cfg, symB, tmpDir, undefined, cache);

    // One shared entry for shared.ts — the second symbol's extraction did not
    // re-read / re-strip / re-split the file.
    expect(cache.size).toBe(1);
    expect([...cache.keys()][0].endsWith(path.join('src', 'shared.ts'))).toBe(true);
  });

  it('does not error or re-stale sections for co-mapped symbols whose signature did not change', async () => {
    // Realistic mixed graph: sections 'Login flow' and 'Session refresh' are
    // both mapped to the UNCHANGED `Session` interface; 'Login flow' is also
    // mapped to `authenticate`, whose signature genuinely changed (and the doc
    // quotes it in bare form, without the `export function` prefix). Sync must
    // update the changed symbol's text while leaving the unchanged symbol —
    // and the in_sync 'Session refresh' section — completely alone. Previously
    // every unchanged co-mapped symbol produced a spurious "requires
    // manual/agent rewrite" error AND dragged its in_sync sections into the
    // stale set, so staleness metastasized across sync runs.
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'auth.ts'),
      'export interface Session { token: string; }\n\nexport function authenticate(username: string, password: string, mfaCode?: string): Session {\n  return { token: username };\n}\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'auth.md'),
      '# Auth\n\n## Login flow\n\n`authenticate(username: string, password: string): Session`\n\n## Session refresh\n\nUses `Session` objects.\n',
      'utf-8',
    );

    const symAuth = symbolId('typescript', 'src/auth.ts::authenticate', 'function');
    const symSess = symbolId('typescript', 'src/auth.ts::Session', 'interface');
    upsertSymbol(db, {
      id: symAuth, name: 'authenticate', kind: 'function', location: 'src/auth.ts:3',
      raw_signature: 'export function authenticate(username: string, password: string, mfaCode?: string): Session {',
    });
    upsertSymbol(db, {
      id: symSess, name: 'Session', kind: 'interface', location: 'src/auth.ts:1',
      raw_signature: 'export interface Session { token: string; }',
    });
    const login = docSectionId('docs/auth.md', 'Login flow');
    const refresh = docSectionId('docs/auth.md', 'Session refresh');
    upsertDocSection(db, { id: login, file: 'docs/auth.md', anchor: 'Login flow', doc_type: 'standalone', status: 'stale' });
    upsertDocSection(db, { id: refresh, file: 'docs/auth.md', anchor: 'Session refresh', doc_type: 'standalone', status: 'in_sync' });
    createMapping(db, { symbol_id: symAuth, doc_id: login, rel_type: 'describes' });
    createMapping(db, { symbol_id: symSess, doc_id: login, rel_type: 'describes' });
    createMapping(db, { symbol_id: symSess, doc_id: refresh, rel_type: 'describes' });
    // The recorded signature change that staled 'Login flow'.
    db.prepare(
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig) VALUES (?, 'signature_changed', ?, ?)",
    ).run(
      symAuth,
      'export function authenticate(username: string, password: string): Session {',
      'export function authenticate(username: string, password: string, mfaCode?: string): Session {',
    );

    const out = await syncAllStale(db, fakeCodegraph, makeConfig({ standalone: 'auto_update' }), tmpDir);

    expect(out.totalStale).toBe(1);
    const byId = new Map(out.synced.map((r) => [r.symbolId, r]));
    // Changed symbol: the bare-form candidate updates the doc, no errors.
    expect(byId.get(symAuth)!.errors).toHaveLength(0);
    expect(byId.get(symAuth)!.docsUpdated).toContain('docs/auth.md');
    // Unchanged co-mapped symbol: no spurious rewrite error, nothing re-staled.
    expect(byId.get(symSess)!.errors).toHaveLength(0);
    expect(byId.get(symSess)!.docsStaled).toHaveLength(0);
    const after = fs.readFileSync(path.join(tmpDir, 'docs', 'auth.md'), 'utf-8');
    expect(after).toContain('authenticate(username: string, password: string, mfaCode?: string): Session');
    // 'Login flow' is back in sync; 'Session refresh' was never dragged in.
    expect(getDocSection(db, login)!.status).toBe('in_sync');
    expect(getDocSection(db, refresh)!.status).toBe('in_sync');
  });
});
