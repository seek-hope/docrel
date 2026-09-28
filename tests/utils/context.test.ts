import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { getDocHealthContext, getDocHealthContextObject } from '../../src/agents/context.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('getDocHealthContext', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-ctx-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('summarizes an empty database', () => {
    expect(getDocHealthContext(db)).toBe('DocRelay status: 0 symbols tracked, no docs tracked.');
    expect(getDocHealthContextObject(db)).toMatchObject({
      totalSymbols: 0,
      linkedPercentage: 0,
      syncPercentage: 0,
      staleDocFiles: [],
    });
  });

  it('reports linked percentages and all-in-sync state', () => {
    const symA = symbolId('typescript', 'src/a.ts::A', 'class');
    const symB = symbolId('typescript', 'src/b.ts::B', 'class');
    const docA = docSectionId('docs/a.md', 'A');
    upsertSymbol(db, { id: symA, name: 'A', kind: 'class', location: 'src/a.ts:1' });
    upsertSymbol(db, { id: symB, name: 'B', kind: 'class', location: 'src/b.ts:1' });
    upsertDocSection(db, { id: docA, file: 'docs/a.md', anchor: 'A', doc_type: 'standalone', status: 'in_sync' });
    createMapping(db, { symbol_id: symA, doc_id: docA, rel_type: 'describes' });

    expect(getDocHealthContext(db)).toBe(
      'DocRelay status: 2 symbols tracked, 1 docs linked (50%), all docs in sync.',
    );
    expect(getDocHealthContextObject(db)).toMatchObject({
      totalSymbols: 2,
      linkedSymbols: 1,
      linkedPercentage: 50,
      totalDocs: 1,
      syncedDocs: 1,
      syncPercentage: 100,
    });
  });

  it('lists stale docs with anchors and truncates beyond five', () => {
    for (let i = 0; i < 7; i++) {
      upsertDocSection(db, {
        id: docSectionId(`docs/s${i}.md`, `Sec${i}`),
        file: `docs/s${i}.md`,
        anchor: `Sec${i}`,
        doc_type: 'standalone',
        status: 'stale',
      });
    }

    const out = getDocHealthContext(db);
    expect(out).toContain('7 docs stale');
    expect(out).toContain('docs/s0.md#Sec0');
    expect(out).toContain('and 2 more');
    expect(out).toContain('Run `docrelay sync` to update.');

    const obj = getDocHealthContextObject(db);
    expect(obj.staleDocFiles).toHaveLength(7);
    expect(obj.staleDocDetails).toHaveLength(7);
  });

  it('returns safe fallbacks when the database is closed', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    closeDb(tmpDir);

    expect(getDocHealthContext(db)).toBe('DocRelay status: unavailable (database query failed).');
    expect(getDocHealthContextObject(db)).toMatchObject({ totalSymbols: 0, staleDocDetails: [] });
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});
