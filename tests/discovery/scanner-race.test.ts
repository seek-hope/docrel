// Cover the TOCTOU recovery path in scanProject: markSignatureChanged
// returning false after a successful upsert (symbol deleted concurrently,
// or a spurious 0-row update).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { scanProject } from '../../src/discovery/scanner.js';
import { BuiltinExtractor } from '../../src/extractors/builtin.js';
import { markSignatureChanged } from '../../src/db/symbols.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/db/symbols.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db/symbols.js')>();
  return { ...mod, markSignatureChanged: vi.fn() };
});

const mockMSC = vi.mocked(markSignatureChanged);

function makeConfig(projectRoot: string): DocRelayConfig {
  return {
    version: 1,
    project: projectRoot,
    doc_dirs: ['docs'],
    code_dirs: ['src'],
    strategies: {
      inline: 'auto_update',
      standalone: 'auto_update',
      generated: 'auto_update',
      architecture: 'mark_stale',
    },
  };
}

describe('scanProject markSignatureChanged TOCTOU recovery', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-scanrace-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'export function compute(a: number): number {\n  return a + 1;\n}\n');
    db = getDb(tmpDir);
    runMigrations(db);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function scanTwiceWithChange(): Promise<Awaited<ReturnType<typeof scanProject>>> {
    const config = makeConfig(tmpDir);
    const extractor = new BuiltinExtractor();
    await scanProject(extractor, db, config, tmpDir, true);
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'export function compute(a: number, b: number): number {\n  return a + b;\n}\n');
    // Full re-scan (fullScan=true): the incremental since-cutoff has a 1s
    // tolerance that would skip a file rewritten in the same second.
    return scanProject(extractor, db, config, tmpDir, true);
  }

  it('inserts the changelog directly when the symbol still exists', async () => {
    mockMSC.mockReturnValue(false);

    const report = await scanTwiceWithChange();

    expect(report.updatedSymbols).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('race condition?'));
    const rows = db.prepare("SELECT change_type FROM changelog WHERE change_type = 'signature_changed'").all();
    expect(rows).toHaveLength(1);
  });

  it('warns and skips the changelog when the symbol was deleted concurrently', async () => {
    mockMSC.mockImplementation((dbArg, id) => {
      dbArg.prepare('DELETE FROM symbols WHERE id = ?').run(id);
      return false;
    });

    const report = await scanTwiceWithChange();

    expect(report.updatedSymbols).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('symbol deleted concurrently'));
    const rows = db.prepare("SELECT change_type FROM changelog WHERE change_type = 'signature_changed'").all();
    expect(rows).toHaveLength(0);
  });
});
