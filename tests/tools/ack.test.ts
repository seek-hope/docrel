/**
 * docrelayAck: the acknowledgement path for stale-but-accurate doc sections.
 * Covers single-doc transitions (stale -> in_sync, not-stale, missing),
 * --all batch semantics, and argument validation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { docSectionId } from '../../src/utils/hash.js';
import { docrelayAck } from '../../src/tools/ack.js';

describe('docrelayAck', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const seed = (anchor: string, status: 'stale' | 'in_sync' = 'stale', file = 'docs/guide.md'): string => {
    const id = docSectionId(file, anchor);
    upsertDocSection(db, { id, file, anchor, doc_type: 'standalone', status });
    return id;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-ack-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('transitions a stale section back to in_sync', () => {
    const id = seed('Install');
    const report = docrelayAck(db, { docId: id });

    expect(report.acknowledged).toEqual([{ id, file: 'docs/guide.md', anchor: 'Install' }]);
    expect(report.notStale).toEqual([]);
    expect(report.notFound).toEqual([]);
    expect(getDocSection(db, id)?.status).toBe('in_sync');
  });

  it('reports a non-stale section as notStale without touching it', () => {
    const id = seed('Fresh Section', 'in_sync');
    const report = docrelayAck(db, { docId: id });

    expect(report.acknowledged).toEqual([]);
    expect(report.notStale).toEqual([{ id, file: 'docs/guide.md', anchor: 'Fresh Section', status: 'in_sync' }]);
    expect(getDocSection(db, id)?.status).toBe('in_sync');
  });

  it('reports an unknown id as notFound', () => {
    const report = docrelayAck(db, { docId: docSectionId('docs/ghost.md', 'Nope') });
    expect(report.acknowledged).toEqual([]);
    expect(report.notFound).toHaveLength(1);
  });

  it('acknowledges by file#anchor', () => {
    const id = seed('Install');
    const report = docrelayAck(db, { docId: 'docs/guide.md#Install' });
    expect(report.acknowledged).toEqual([{ id, file: 'docs/guide.md', anchor: 'Install' }]);
    expect(getDocSection(db, id)?.status).toBe('in_sync');
  });

  it('acknowledges by a unique bare anchor', () => {
    const id = seed('Install');
    const report = docrelayAck(db, { docId: 'Install' });
    expect(report.acknowledged).toEqual([{ id, file: 'docs/guide.md', anchor: 'Install' }]);
  });

  it('throws with candidates on an ambiguous bare anchor', () => {
    seed('Setup', 'stale', 'docs/a.md');
    seed('Setup', 'stale', 'docs/b.md');
    expect(() => docrelayAck(db, { docId: 'Setup' })).toThrow('matches 2 doc sections');
  });

  it('--all acknowledges every stale section across files and leaves in_sync rows alone', () => {
    const a = seed('A');
    const b = seed('B', 'stale', 'README.md');
    const c = seed('C', 'in_sync');
    const report = docrelayAck(db, { all: true });

    expect(report.acknowledged.map((e) => e.id).sort()).toEqual([a, b].sort());
    expect(report.notStale).toEqual([]);
    expect(getDocSection(db, a)?.status).toBe('in_sync');
    expect(getDocSection(db, b)?.status).toBe('in_sync');
    expect(getDocSection(db, c)?.status).toBe('in_sync');
  });

  it('--all on a clean database acknowledges nothing', () => {
    seed('Clean', 'in_sync');
    const report = docrelayAck(db, { all: true });
    expect(report.acknowledged).toEqual([]);
    expect(report.notFound).toEqual([]);
  });

  it('throws when neither docId nor all is given', () => {
    expect(() => docrelayAck(db, {})).toThrow('ack requires a doc id or all=true');
  });
});
