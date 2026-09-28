import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { docrelayHealth } from '../../src/tools/health.js';
import { docSectionId } from '../../src/utils/hash.js';

describe('health last_scan check', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-health-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function lastScanMessage(): Promise<string> {
    // docrelayHealth needs an availability probe; supply a trivial one.
    return docrelayHealth(db, tmpDir, () => Promise.resolve(false), '0.0.0-test')
      .then((r) => r.checks.find((c) => c.name === 'last_scan')!.message);
  }

  it('accepts ISO-8601 last_scan_at (what the scanner writes now)', async () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES ('last_scan_at', ?)")
      .run(new Date().toISOString());
    const msg = await lastScanMessage();
    expect(msg).toMatch(/^Last scan \d+h ago$/);
    expect(msg).not.toContain('Never scanned');
  });

  it('accepts legacy SQLite UTC format (YYYY-MM-DD HH:MM:SS)', async () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES ('last_scan_at', datetime('now'))").run();
    const msg = await lastScanMessage();
    expect(msg).toMatch(/^Last scan \d+h ago$/);
  });

  it('reports Never scanned only when the row is truly missing/unparseable', async () => {
    expect(await lastScanMessage()).toContain('Never scanned');
    db.prepare("INSERT INTO metadata (key, value) VALUES ('last_scan_at', 'garbage')").run();
    expect(await lastScanMessage()).toContain('Never scanned');
  });
});

describe('docrelayHealth checks', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-healthchecks-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports codegraph ok when the probe succeeds', async () => {
    const report = await docrelayHealth(db, tmpDir, () => Promise.resolve(true), '0.0.0-test');
    const cg = report.checks.find((c) => c.name === 'codegraph')!;
    expect(cg.status).toBe('ok');
    expect(cg.message).toBe('Codegraph is reachable');
  });

  it('degrades with a sanitized message when the codegraph probe throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await docrelayHealth(db, tmpDir, () => Promise.reject(new Error('boom')), '0.0.0-test');

    const cg = report.checks.find((c) => c.name === 'codegraph')!;
    expect(cg.status).toBe('degraded');
    expect(cg.message).toBe('Internal error during health check — check server logs');
    expect(errSpy).toHaveBeenCalledWith('Codegraph check failed:', 'boom');
  });

  it('degrades stale_docs below 10% and fails at or above 10%', async () => {
    const addDocs = (total: number, stale: number) => {
      for (let i = 0; i < total; i++) {
        upsertDocSection(db, {
          id: docSectionId(`docs/f${i}.md`, 'S'),
          file: `docs/f${i}.md`,
          anchor: 'S',
          doc_type: 'standalone',
          status: i < stale ? 'stale' : 'in_sync',
        });
      }
    };

    addDocs(11, 1);
    let report = await docrelayHealth(db, tmpDir, () => Promise.resolve(true), '0.0.0-test');
    let sd = report.checks.find((c) => c.name === 'stale_docs')!;
    expect(sd.status).toBe('degraded');
    expect(sd.message).toContain('1/11 docs stale (9%)');

    db.prepare('DELETE FROM doc_sections').run();
    addDocs(2, 1);
    report = await docrelayHealth(db, tmpDir, () => Promise.resolve(true), '0.0.0-test');
    sd = report.checks.find((c) => c.name === 'stale_docs')!;
    expect(sd.status).toBe('failed');
    expect(sd.message).toContain('1/2 docs stale (50%)');
  });

  it('degrades last_scan when the previous scan is older than 24h', async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_scan_at', ?)").run(old);

    const report = await docrelayHealth(db, tmpDir, () => Promise.resolve(true), '0.0.0-test');

    const ls = report.checks.find((c) => c.name === 'last_scan')!;
    expect(ls.status).toBe('degraded');
    expect(ls.message).toContain('consider re-scanning');
  });

  it('summarizes degraded-but-functional when no check failed', async () => {
    // A missing .docrelay/config.yaml fails the config check; seed a VALID
    // config (with existing doc/code dirs, or validation reports errors) so
    // every check is ok-or-degraded.
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), 'version: 1\ndoc_dirs: [docs]\ncode_dirs: [src]\n', 'utf-8');
    const report = await docrelayHealth(db, tmpDir, () => Promise.resolve(false), '0.0.0-test');

    expect(report.healthy).toBe(true);
    expect(report.summary).toContain('check(s) degraded — system is functional with reduced capability');
  });

  it('fails the database check with a sanitized message when the query throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const proxy = {
      prepare(sql: string) {
        if (sql.includes('SELECT 1 AS ok')) throw new Error('kaput');
        return db.prepare(sql);
      },
    } as unknown as Database.Database;

    const report = await docrelayHealth(proxy, tmpDir, () => Promise.resolve(true), '0.0.0-test');

    const dbCheck = report.checks.find((c) => c.name === 'database')!;
    expect(dbCheck.status).toBe('failed');
    expect(dbCheck.message).toBe('Internal error during health check — check server logs');
    expect(errSpy).toHaveBeenCalledWith('Database query failed:', 'kaput');
  });

  it('fails the database check on an unexpected SELECT 1 result', async () => {
    const proxy = {
      prepare(sql: string) {
        if (sql.includes('SELECT 1 AS ok')) return { get: () => ({ ok: 2 }) };
        return db.prepare(sql);
      },
    } as unknown as Database.Database;

    const report = await docrelayHealth(proxy, tmpDir, () => Promise.resolve(true), '0.0.0-test');

    const dbCheck = report.checks.find((c) => c.name === 'database')!;
    expect(dbCheck.status).toBe('failed');
    expect(dbCheck.message).toBe('Database returned unexpected result');
  });

  it('wraps a throwing unguarded check and marks the report unhealthy', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const proxy = {
      prepare(sql: string) {
        if (sql.includes('FROM doc_sections')) throw new Error('kaput');
        return db.prepare(sql);
      },
    } as unknown as Database.Database;

    const report = await docrelayHealth(proxy, tmpDir, () => Promise.resolve(true), '0.0.0-test');

    const wrapped = report.checks.filter((c) => c.status === 'failed' && c.message === 'Internal error during health check — check server logs');
    expect(wrapped.length).toBeGreaterThanOrEqual(1);
    expect(report.healthy).toBe(false);
    expect(report.summary).toContain('check(s) failed');
    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("threw:"), 'kaput');
  });
});

describe('docrelayHealth extended diagnostics', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-healthext-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function checkMessage(name: string): Promise<{ status: string; message: string }> {
    const report = await docrelayHealth(db, tmpDir, () => Promise.resolve(false), '0.0.0-test');
    const c = report.checks.find((x) => x.name === name)!;
    return { status: c.status, message: c.message };
  }

  it('db_writable is ok on a normal writable database', async () => {
    expect((await checkMessage('db_writable')).status).toBe('ok');
  });

  it('db_writable fails when the database file is read-only', async () => {
    const dbFile = path.join(tmpDir, '.git', 'docrelay.db');
    const dbDir = path.dirname(dbFile);
    fs.chmodSync(dbFile, 0o444);
    fs.chmodSync(dbDir, 0o555);
    try {
      const c = await checkMessage('db_writable');
      expect(c.status).toBe('failed');
      expect(c.message).toContain('read-only');
    } finally {
      // Restore writability so afterEach can remove the tree.
      fs.chmodSync(dbDir, 0o755);
      fs.chmodSync(dbFile, 0o644);
    }
  });

  it('schema_version is ok at the current version and fails on a newer one', async () => {
    expect((await checkMessage('schema_version')).status).toBe('ok');
    db.pragma('user_version = 99');
    const c = await checkMessage('schema_version');
    expect(c.status).toBe('failed');
    expect(c.message).toContain('v99');
    expect(c.message).toContain('upgrade DocRelay');
  });

  it('config is ok on a valid config and degrades on warnings', async () => {
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), 'version: 1\ndoc_dirs: [docs]\ncode_dirs: [src]\n', 'utf-8');
    expect((await checkMessage('config')).status).toBe('ok');

    // Future config version with otherwise valid dirs → warning → degraded.
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), 'version: 999\ndoc_dirs: [docs]\ncode_dirs: [src]\n', 'utf-8');
    expect((await checkMessage('config')).status).toBe('degraded');
  });

  it('config fails with an error-severity validation issue', async () => {
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    // doc_dirs entry does not exist on disk → error severity.
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), 'version: 1\ndoc_dirs: [missing-dir]\ncode_dirs: [also-missing]\n', 'utf-8');
    const c = await checkMessage('config');
    expect(c.status).toBe('failed');
    expect(c.message).toContain('config validate');
  });

  it('pending_changes degrades with the count of unsynced changelog rows', async () => {
    expect((await checkMessage('pending_changes')).status).toBe('ok');
    upsertSymbol(db, { id: 's1', name: 'login', kind: 'function' });
    db.prepare("INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig) VALUES ('s1', 'signature_changed', 'a', 'b')").run();
    const c = await checkMessage('pending_changes');
    expect(c.status).toBe('degraded');
    expect(c.message).toContain('1 change(s)');
    expect(c.message).toContain('docrelay sync');
  });

  it('hooks degrades when pre-commit is missing and is ok once installed', async () => {
    const missing = await checkMessage('hooks');
    expect(missing.status).toBe('degraded');
    expect(missing.message).toContain('install-hooks');

    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect((await checkMessage('hooks')).status).toBe('ok');
  });

  it('orphan_mappings reports integrity drift with gc guidance', async () => {
    expect((await checkMessage('orphan_mappings')).status).toBe('ok');
    // Seed an orphan by bypassing FK enforcement for the setup write.
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO mappings (symbol_id, doc_id, rel_type) VALUES ('ghost-sym', 'ghost-doc', 'describes')").run();
    db.pragma('foreign_keys = ON');
    const c = await checkMessage('orphan_mappings');
    expect(c.status).toBe('degraded');
    expect(c.message).toContain('1 mapping(s)');
    expect(c.message).toContain('docrelay gc');
  });
});
