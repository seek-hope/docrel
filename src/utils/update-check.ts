// src/utils/update-check.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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

function cachePath(): string {
  // Use deterministic cache path to avoid unbounded file accumulation in /tmp.
  // The filename includes a hash of the package name to avoid collision.
  const pkgHash = crypto.createHash('sha256').update('docrel').digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `docrel-update-check-${pkgHash}.json`);
}

function readCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    const entry = validateCacheEntry(parsed);
    if (entry) return entry;
    return null;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    // Overwrite (w) — cache must be updatable after first write.
    // The original 'wx' (exclusive creation) flag would fail EEXIST on every
    // subsequent call, leaving the cache permanently stale.
    fs.writeFileSync(cachePath(), JSON.stringify(entry), { encoding: 'utf-8', flag: 'w' });
  } catch {
    // best-effort
  }
}

/**
 * Check npm registry for the latest version of docrel.
 * Uses a local cache to avoid checking more than once per day.
 * Non-blocking — caller should call this in the background.
 */
export async function checkForUpdates(currentVersion: string): Promise<string | null> {
  // Check cache first
  const cached = readCache();
  if (cached && Date.now() - cached.lastCheck < CHECK_INTERVAL_MS) {
    return cached.latestVersion !== currentVersion ? cached.latestVersion : null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch('https://registry.npmjs.org/docrel/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();
    if (typeof data?.version !== 'string' || data.version.length === 0) return null;
    const latest = data.version;

    // Validate semver-like format to guard against spoofed registry responses
    if (!/^\d+\.\d+\.\d+(\+[a-zA-Z0-9.]+)?$/.test(latest)) return null;

    // Reject pre-release versions (beta, alpha, rc) so stable users are not
    // prompted to install unstable releases. Strip any build metadata (+) but
    // keep the numeric version for comparison.
    const stablePart = latest.split('+')[0] ?? latest;
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
  const cleanCurrent = current.split('-')[0] ?? current;
  const cleanLatest = latest.split('-')[0] ?? latest;

  const curParts = cleanCurrent.split('.').map(Number);
  const latParts = cleanLatest.split('.').map(Number);

  // If any segment is non-numeric, fall back to string comparison
  if (curParts.some(isNaN) || latParts.some(isNaN)) {
    return latest !== current;
  }

  for (let i = 0; i < 3; i++) {
    const c = curParts[i] ?? 0;
    const l = latParts[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false; // equal versions
}
