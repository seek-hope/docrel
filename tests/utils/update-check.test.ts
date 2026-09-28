import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkForUpdates, isNewer } from '../../src/utils/update-check.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const CURRENT = '0.3.1';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('isNewer', () => {
  it('compares numeric semver segments', () => {
    expect(isNewer('0.3.1', '0.3.2')).toBe(true);
    expect(isNewer('0.3.1', '0.4.0')).toBe(true);
    expect(isNewer('0.3.1', '1.0.0')).toBe(true);
    expect(isNewer('0.3.1', '0.3.1')).toBe(false);
    expect(isNewer('0.3.1', '0.3.0')).toBe(false);
    expect(isNewer('0.3.1', '0.2.9')).toBe(false);
    expect(isNewer('1.10.0', '1.9.9')).toBe(false);
    expect(isNewer('1.9.9', '1.10.0')).toBe(true);
  });

  it('strips pre-release suffixes before comparing', () => {
    expect(isNewer('0.3.1-beta.1', '0.3.1')).toBe(false);
    expect(isNewer('0.3.1', '0.3.2-rc.1')).toBe(true);
  });

  it('returns false for non-numeric segments', () => {
    expect(isNewer('abc', '0.3.2')).toBe(false);
    expect(isNewer('0.3.1', 'x.y.z')).toBe(false);
  });
});

describe('checkForUpdates', () => {
  let homeDir: string;
  let cacheFile: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-upd-'));
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    cacheFile = path.join(homeDir, '.cache', 'docrelay', 'update-check.json');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function writeCache(entry: unknown): void {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(entry), 'utf-8');
  }

  it('returns the newer version from the registry and writes the cache', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.4.0' }));

    const result = await checkForUpdates(CURRENT);

    expect(result).toBe('0.4.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as { latestVersion: string };
    expect(cached.latestVersion).toBe('0.4.0');
  });

  it('returns null when the registry version equals the current version', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: CURRENT }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('returns null when the registry version is OLDER than current (running ahead of npm)', async () => {
    // Regression: the fetch path must not report downgrades as updates.
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.2.5' }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('serves a newer version from a fresh cache without hitting the network', async () => {
    writeCache({ lastCheck: Date.now(), latestVersion: '0.4.0' });

    const result = await checkForUpdates(CURRENT);

    expect(result).toBe('0.4.0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null from a fresh cache matching the current version', async () => {
    writeCache({ lastCheck: Date.now(), latestVersion: CURRENT });
    expect(await checkForUpdates(CURRENT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-fetches when the cached version is stale (older than current)', async () => {
    writeCache({ lastCheck: Date.now(), latestVersion: '0.2.5' });
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.2.5' }));

    const result = await checkForUpdates(CURRENT);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed cache shape and fetches anyway', async () => {
    writeCache({ lastCheck: 'yesterday', latestVersion: 42 });
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.4.0' }));

    expect(await checkForUpdates(CURRENT)).toBe('0.4.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('warns and re-fetches on a corrupt cache file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, '{not json', 'utf-8');
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.4.0' }));

    expect(await checkForUpdates(CURRENT)).toBe('0.4.0');
    expect(warnSpy).toHaveBeenCalled();
  });

  // NOTE on ordering: the module-level write-failure latch is consumed by
  // the first failing cache write, so the write-failure test must run before
  // the mkdir-failure test (whose writes also fail, with ENOENT).
  it('warns once when the cache file cannot be written', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, data: any, opts: any) => {
      if (String(p) === cacheFile) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return realWrite(p, data, opts as never);
    }) as typeof fs.writeFileSync);
    // Fresh Response per fetch — Response bodies are single-use.
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '0.4.0' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '0.4.0' }));

    expect(await checkForUpdates(CURRENT)).toBe('0.4.0');
    expect(await checkForUpdates(CURRENT)).toBe('0.4.0');
    const writeWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('cannot write update-check cache'));
    expect(writeWarns).toHaveLength(1);
  });

  it('warns once when the cache directory cannot be created', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realMkdir = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: any, opts: any) => {
      if (String(p).includes('.cache')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realMkdir(p, opts as never) as never;
    }) as typeof fs.mkdirSync);
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '0.4.0' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '0.4.0' }));

    await checkForUpdates(CURRENT);
    await checkForUpdates(CURRENT);
    const mkdirWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('cannot create update-check cache directory'));
    expect(mkdirWarns).toHaveLength(1);
  });

  it('returns null on HTTP errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('returns null on a non-JSON content type', async () => {
    fetchMock.mockResolvedValue(new Response('<html>ok</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('returns null when content-length exceeds the size cap', async () => {
    fetchMock.mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
    }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('returns null on an invalid JSON body', async () => {
    fetchMock.mockResolvedValue(new Response('{oops', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('returns null on a missing or non-semver version field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'doc-relay' }));
    expect(await checkForUpdates(CURRENT)).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse({ version: 'latest' }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('returns null for pre-release versions', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.4.0-beta.1' }));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });

  it('returns null when fetch throws (offline)', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await checkForUpdates(CURRENT)).toBeNull();
  });
});
