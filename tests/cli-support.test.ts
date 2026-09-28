import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { errMsg, createExtractor, scanWithFallback, isProjectInitialized } from '../src/cli-support.js';
import { getDb, closeAllDbs } from '../src/db/connection.js';
import { runMigrations } from '../src/db/schema.js';
import { BuiltinExtractor } from '../src/extractors/builtin.js';
import type { SymbolExtractor } from '../src/extractors/interface.js';
import type { CodegraphClient } from '../src/codegraph/client.js';
import type { DocRelayConfig } from '../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const config: DocRelayConfig = {
  version: 1,
  project: 'test',
  doc_dirs: ['docs'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'auto_update',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

describe('errMsg', () => {
  const root = '/home/user/project';

  it('extracts messages from Errors and redacts the project root', () => {
    expect(errMsg(new Error(`failed in ${root}/src/file.ts`), root)).toBe('failed in <projectRoot>/src/file.ts');
  });

  it('redacts common absolute path prefixes', () => {
    expect(errMsg(new Error('cannot read /etc/secrets/key.pem now'), root))
      .toBe('cannot read <path> now');
    expect(errMsg(new Error('bad /tmp/build-output.js'), root)).toBe('bad <path>');
  });

  it('passes strings through and maps unknown shapes to a placeholder', () => {
    expect(errMsg('plain failure', root)).toBe('plain failure');
    expect(errMsg({ code: 42 }, root)).toBe('unknown error');
    expect(errMsg(null, root)).toBe('unknown error');
    expect(errMsg(undefined, root)).toBe('unknown error');
  });
});

describe('createExtractor', () => {
  it('returns the codegraph extractor when available, builtin otherwise', async () => {
    const available = { isAvailable: vi.fn().mockResolvedValue(true) } as unknown as CodegraphClient;
    const ext1 = await createExtractor(available, config);
    expect(ext1.name).toBe('codegraph');

    const unavailable = { isAvailable: vi.fn().mockResolvedValue(false) } as unknown as CodegraphClient;
    const ext2 = await createExtractor(unavailable, config);
    expect(ext2.name).toBe('builtin');
  });
});

describe('isProjectInitialized', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-init-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is false with neither marker, true with .docrelay/ or .git/docrelay.db', () => {
    expect(isProjectInitialized(tmpDir)).toBe(false);

    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    expect(isProjectInitialized(tmpDir)).toBe(false); // .git without the DB is not enough
    fs.writeFileSync(path.join(tmpDir, '.git', 'docrelay.db'), '', 'utf-8');
    expect(isProjectInitialized(tmpDir)).toBe(true);
    fs.rmSync(path.join(tmpDir, '.git'), { recursive: true });

    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    expect(isProjectInitialized(tmpDir)).toBe(true);
  });
});

describe('scanWithFallback', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-fallback-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'a.ts'),
      'export function alpha(): number { return 1; }\n',
      'utf-8',
    );
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeAllDbs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const zeroExtractor: SymbolExtractor = {
    name: 'codegraph',
    extract: vi.fn().mockResolvedValue([]),
    isAvailable: vi.fn().mockResolvedValue(true),
  };

  it('falls back to the builtin extractor when codegraph finds 0 symbols in a non-empty dir', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const report = await scanWithFallback(zeroExtractor, db, config, tmpDir);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fell back to builtin'));
    expect(report.totalSymbols).toBeGreaterThanOrEqual(1); // builtin found alpha()
  });

  it('does not fall back when the extractor finds symbols', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await scanWithFallback(new BuiltinExtractor(), db, config, tmpDir);

    expect(report.totalSymbols).toBeGreaterThanOrEqual(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
