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
  // Use random filename to prevent symlink-based attacks on predictable paths
  return path.join(os.tmpdir(), `docrel-update-check-${crypto.randomUUID()}.json`);
}

function readCache(): CacheEntry | null {
  // Find the most recent cache file (glob for docrel-update-check-*.json)
  try {
    const tmpDir = os.tmpdir();
    const prefix = 'docrel-update-check-';
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(tmpDir, file), 'utf-8');
        const parsed = JSON.parse(raw);
        const entry = validateCacheEntry(parsed);
        if (entry) {
          // Remove old-named cache files (backward compatibility)
          const oldPath = path.join(os.tmpdir(), 'docrel-update-check.json');
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
          return entry;
        }
      } catch { /* skip corrupt cache files */ }
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    // Use exclusive creation flag (wx) to fail if file already exists
    fs.writeFileSync(cachePath(), JSON.stringify(entry), { encoding: 'utf-8', flag: 'wx' });
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

    const data = await response.json() as { version: string };
    const latest = data.version;

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
