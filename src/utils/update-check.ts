// src/utils/update-check.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FETCH_TIMEOUT_MS = 5000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  lastCheck: number;
  latestVersion: string;
}

/** Zod-compatible inline validation for the update-check cache. */
function validateCacheEntry(raw: unknown): CacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.lastCheck !== 'number' || typeof obj.latestVersion !== 'string') return null;
  return { lastCheck: obj.lastCheck, latestVersion: obj.latestVersion };
}

let cacheWriteWarned = false;

function cachePath(): string {
  // Use a user-specific cache directory (XDG-style) instead of os.tmpdir().
  // os.tmpdir() is world-writable and the deterministic filename would allow
  // an attacker on a multi-user system to pre-create a symlink at the path
  // and corrupt arbitrary files when docrelay writes the cache.
  const cacheDir = path.join(os.homedir(), '.cache', 'docrelay');
  try { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); } catch {
    if (!cacheWriteWarned) {
      cacheWriteWarned = true;
      console.warn(`DocRelay: cannot create update-check cache directory at ${cacheDir} — update checks may hit npm registry on every invocation`);
    }
  }
  return path.join(cacheDir, 'update-check.json');
}

function readCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    const entry = validateCacheEntry(parsed);
    if (entry) return entry;
    return null;
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('DocRelay: cannot read update-check cache:', err instanceof Error ? err.message : err);
    }
    return null;
  }
}

let cacheWriteFailed = false;

function writeCache(entry: CacheEntry): void {
  try {
    // Overwrite (w) — cache must be updatable after first write.
    // The original 'wx' (exclusive creation) flag would fail EEXIST on every
    // subsequent call, leaving the cache permanently stale.
    fs.writeFileSync(cachePath(), JSON.stringify(entry), { encoding: 'utf-8', flag: 'w', mode: 0o600 });
  } catch (err: any) {
    if (!cacheWriteFailed) {
      cacheWriteFailed = true;
      console.warn('DocRelay: cannot write update-check cache:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Check npm registry for the latest version of docrelay.
 * Uses a local cache to avoid checking more than once per day.
 * Non-blocking — caller should call this in the background.
 */
export async function checkForUpdates(currentVersion: string): Promise<string | null> {
  // Check cache first
  const cached = readCache();
  if (cached && Date.now() - cached.lastCheck < CHECK_INTERVAL_MS) {
    // Only return cached version if it is newer than current.
    // If the user upgraded since the cache was written (e.g. from
    // v1.0.0 to v3.0.0), the cached v2.0.0 is stale — re-fetch instead
    // of returning an older version that isNewer() would discard anyway.
    if (cached.latestVersion === currentVersion) return null;
    if (isNewer(currentVersion, cached.latestVersion)) return cached.latestVersion;
    // Cache is stale (cached version <= current) — fall through to re-fetch
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch('https://registry.npmjs.org/doc-relay/latest', {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) return null;

    // Validate Content-Type to defend against MITM serving crafted responses.
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) return null;

    // Guard against oversized responses that could OOM during JSON.parse.
    // The npm registry response for /doc-relay/latest is typically < 1 KB.
    // Check Content-Length first (no body read); fall back to reading the
    // body as text with a size cap when Content-Length is absent.
    const MAX_RESPONSE_SIZE = 102_400; // 100 KB
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const len = parseInt(contentLength, 10);
      if (isNaN(len) || len > MAX_RESPONSE_SIZE) return null;
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) return null;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (typeof data?.version !== 'string' || data.version.length === 0) return null;
    const latest = data.version;

    // Validate semver-like format to guard against spoofed registry responses
    if (!/^\d+\.\d+\.\d+(\+[a-zA-Z0-9.]+)?$/.test(latest)) return null;

    // Reject pre-release versions (beta, alpha, rc) so stable users are not
    // prompted to install unstable releases. Strip any build metadata (+) but
    // keep the numeric version for comparison.
    const stablePart = latest.split('+')[0];
    if (stablePart.includes('-')) return null;

    writeCache({ lastCheck: Date.now(), latestVersion: latest });

    if (latest !== currentVersion) {
      return latest;
    }
    return null;
  } catch {
    // Network errors, timeouts, etc. — silently ignore
    return null;
  }
}

/**
 * Simple semver comparison: returns true if `latest` is newer than `current`.
 * Strips pre-release suffixes (e.g., '-beta.1') before numeric comparison.
 * Falls back to string comparison if numeric parsing fails.
 */
export function isNewer(current: string, latest: string): boolean {
  // Strip pre-release suffixes for numeric comparison
  const cleanCurrent = current.split('-')[0];
  const cleanLatest = latest.split('-')[0];

  const curParts = cleanCurrent.split('.').map(Number);
  const latParts = cleanLatest.split('.').map(Number);

  // If any segment is non-numeric, fall back to string comparison
  if (curParts.some(isNaN) || latParts.some(isNaN)) {
    return false; // conservative: don't claim newer unless proven by numeric comparison
  }

  for (let i = 0; i < 3; i++) {
    const c = curParts[i] ?? 0;
    const l = latParts[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false; // equal versions
}
