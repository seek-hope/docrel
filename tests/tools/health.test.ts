import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertDocSection } from '../../src/db/docs.js';
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
    // A missing .docrelay/config.yaml fails the config check; create it so
    // every check is ok-or-degraded.
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), 'version: 1\n', 'utf-8');
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
