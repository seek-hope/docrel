import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { docrelayHealth } from '../../src/tools/health.js';

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

  function lastScanMessage(): string {
    // docrelayHealth needs an availability probe; supply a trivial one.
    return docrelayHealth(db, tmpDir, async () => false, '0.0.0-test')
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
