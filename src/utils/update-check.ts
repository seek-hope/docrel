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

function cachePath(): string {
  return path.join(os.tmpdir(), 'docrel-update-check.json');
}

function readCache(): CacheEntry | null {
  try {
    if (!fs.existsSync(cachePath())) return null;
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(entry), 'utf-8');
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
 */
export function isNewer(current: string, latest: string): boolean {
  const cur = current.split('.').map(Number);
  const lat = latest.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const c = cur[i] ?? 0;
    const l = lat[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false; // equal versions
}
