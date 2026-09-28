import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { docrelayGc } from '../../src/tools/gc.js';
import { upsertSymbol, getSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import type { ScanReport } from '../../src/discovery/scanner.js';

function makeScanReport(scannedIds: string[]): ScanReport {
  return { totalSymbols: scannedIds.length, newSymbols: 0, updatedSymbols: 0, failedDirs: [], scannedIds };
}

describe('docrelayGc', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const present = symbolId('ts', 'src/a.ts::present', 'function');
  const missing = symbolId('ts', 'src/b.ts::missing', 'function');
  const docId = docSectionId('docs/api.md', 'missing');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-gc-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: present, name: 'present', kind: 'function' });
    upsertSymbol(db, { id: missing, name: 'missing', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'missing', doc_type: 'standalone', status: 'in_sync' });
    createMapping(db, { symbol_id: missing, doc_id: docId, rel_type: 'describes' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when every symbol was re-discovered', () => {
    const report = docrelayGc(db, makeScanReport([present, missing]));
    expect(report).toMatchObject({ symbolsRemoved: 0, symbolsMarkedStale: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM changelog').get()).toEqual({ c: 0 });
  });

  it('first miss: marks docs stale and records a __stale__ changelog entry', () => {
    const report = docrelayGc(db, makeScanReport([present]));

    expect(report.symbolsMarkedStale).toBe(1);
    expect(report.symbolsRemoved).toBe(0);
    expect(getSymbol(db, missing)).toBeTruthy(); // not deleted yet
    expect(getDocSection(db, docId)!.status).toBe('stale');

    const row = db.prepare(
      "SELECT change_type, old_sig, affected_docs FROM changelog WHERE symbol_id = ?",
    ).get(missing) as { change_type: string; old_sig: string; affected_docs: string };
    expect(row.change_type).toBe('deleted');
    expect(row.old_sig).toBe('__stale__');
    expect(JSON.parse(row.affected_docs)).toEqual([docId]);
  });

  it('does not stale docs linked only via rejected mappings', () => {
    db.prepare("UPDATE mappings SET review_status = 'rejected' WHERE symbol_id = ?").run(missing);
    const report = docrelayGc(db, makeScanReport([present]));

    expect(report.symbolsMarkedStale).toBe(1); // symbol still tracked
    expect(getDocSection(db, docId)!.status).toBe('in_sync'); // doc untouched
    const row = db.prepare('SELECT affected_docs FROM changelog WHERE symbol_id = ?').get(missing) as { affected_docs: string };
    expect(JSON.parse(row.affected_docs)).toEqual([]);
  });

  it('second consecutive miss: deletes the symbol and cascades mappings', () => {
    docrelayGc(db, makeScanReport([present])); // first miss
    const report = docrelayGc(db, makeScanReport([present])); // second miss

    expect(report.symbolsRemoved).toBe(1);
    expect(report.symbolsMarkedStale).toBe(0);
    expect(getSymbol(db, missing)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS c FROM mappings WHERE symbol_id = ?').get(missing)).toEqual({ c: 0 });
    // Changelog entries for the symbol are cascaded away too.
    expect(db.prepare('SELECT COUNT(*) AS c FROM changelog WHERE symbol_id = ?').get(missing)).toEqual({ c: 0 });
  });

  it('a re-discovered symbol is never collected even after a prior miss', () => {
    docrelayGc(db, makeScanReport([present])); // first miss → stale marker
    const report = docrelayGc(db, makeScanReport([present, missing])); // re-discovered
    expect(report).toMatchObject({ symbolsRemoved: 0, symbolsMarkedStale: 0 });
    expect(getSymbol(db, missing)).toBeTruthy();
  });

  it('dry-run counts both categories without mutating anything', () => {
    const alsoMissing = symbolId('ts', 'src/c.ts::also', 'function');
    upsertSymbol(db, { id: alsoMissing, name: 'also', kind: 'function' });
    // Give `missing` a prior stale marker so dry-run classifies it as would-remove.
    db.prepare(
      "INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig) VALUES (?, 'deleted', '__stale__', '__stale__')",
    ).run(missing);

    const report = docrelayGc(db, makeScanReport([present]), true);

    expect(report).toMatchObject({ symbolsRemoved: 1, symbolsMarkedStale: 1, dryRun: true });
    // Nothing mutated: no new changelog rows, doc still in_sync, symbols alive.
    expect(db.prepare("SELECT COUNT(*) AS c FROM changelog WHERE symbol_id = ?").get(alsoMissing)).toEqual({ c: 0 });
    expect(getDocSection(db, docId)!.status).toBe('in_sync');
    expect(getSymbol(db, missing)).toBeTruthy();
    expect(getSymbol(db, alsoMissing)).toBeTruthy();
  });

  it('returns an error field and rolls back when the transaction fails', () => {
    // Force markDocsStaleForSymbol's SELECT to fail inside the transaction
    // (dropping doc_sections instead would fail gc's own DELETE prepare,
    // which happens before the try block by design).
    db.prepare('DROP TABLE mappings').run();

    const report = docrelayGc(db, makeScanReport([present]));

    expect(report.error).toBeTruthy();
    expect(report.symbolsRemoved).toBe(0);
    expect(report.symbolsMarkedStale).toBe(0);
    // Atomic rollback: no changelog entry committed.
    expect(db.prepare('SELECT COUNT(*) AS c FROM changelog').get()).toEqual({ c: 0 });
    expect(getSymbol(db, missing)).toBeTruthy();
  });
});
