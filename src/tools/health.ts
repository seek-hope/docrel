/**
 * docrelay_health — comprehensive system health check.
 * Checks database connectivity, codegraph availability, filesystem access,
 * and reports any detected error conditions with structured error codes.
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, logError, docrelayError } from '../utils/error-codes.js';
import { assertDbOpen } from '../db/connection.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { parseLastScanAt } from '../discovery/scanner.js';
import { loadConfig, validateConfig } from '../utils/config.js';
import { resolveGitDir } from '../git/hooks.js';

export interface HealthReport {
  healthy: boolean;
  timestamp: string;
  version: string;
  checks: HealthCheck[];
  errors: Array<{ code: string; message: string }>;
  summary: string;
}

export interface HealthCheck {
  name: string;
  status: 'ok' | 'degraded' | 'failed';
  code?: string;
  message: string;
  latencyMs?: number;
}

interface HealthCheckFn {
  (): Promise<HealthCheck>;
}

const CODEGRAPH_HEALTH_TIMEOUT_MS = 5000;

export async function docrelayHealth(
  db: Database.Database,
  projectRoot: string,
  checkCodegraph: () => Promise<boolean>,
  version: string,
): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  const errors: Array<{ code: string; message: string }> = [];

  const run = async (name: string, fn: HealthCheckFn) => {
    try {
      checks.push(await fn());
    } catch (err: any) {
      // Log the full error to stderr so operators can diagnose; return a
      // sanitized message to clients to avoid leaking paths or stack details.
      console.error(`Health check '${name}' threw:`, err instanceof Error ? err.message : err);
      checks.push({
        name,
        status: 'failed',
        code: ErrorCode.INTERNAL_UNEXPECTED,
        message: 'Internal error during health check — check server logs',
      });
    }
  };

  assertDbOpen(db);

  // 1. Database connectivity
  await run('database', async () => {
    const start = Date.now();
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      const latencyMs = Date.now() - start;
      if (row?.ok === 1) {
        return { name: 'database', status: 'ok', message: 'SQLite responding', latencyMs };
      }
      return { name: 'database', status: 'failed', code: ErrorCode.DB_QUERY_FAILED, message: 'Database returned unexpected result', latencyMs };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      // Log the full error so operators can diagnose; return a sanitized
      // message to clients to avoid leaking paths or stack details.
      console.error('Database query failed:', err instanceof Error ? err.message : err);
      return { name: 'database', status: 'failed', code: ErrorCode.DB_CONNECTION_FAILED, message: 'Internal error during health check — check server logs', latencyMs };
    }
  });

  // 2. DocRelay config: exists, parses, and validates
  await run('config', async () => {
    const configPath = path.join(projectRoot, '.docrelay', 'config.yaml');
    if (!fs.existsSync(configPath)) {
      return { name: 'config', status: 'failed', code: ErrorCode.CONFIG_MISSING, message: '.docrelay/config.yaml not found — run docrelay init' };
    }
    try {
      const cfg = loadConfig(projectRoot);
      const issues = validateConfig(cfg, projectRoot);
      const errs = issues.filter((i) => i.severity === 'error');
      if (errs.length > 0) {
        return { name: 'config', status: 'failed', code: ErrorCode.CONFIG_INVALID, message: `${errs.length} config error(s): ${errs[0].message} — run docrelay config validate` };
      }
      if (issues.length > 0) {
        return { name: 'config', status: 'degraded', message: `${issues.length} config warning(s): ${issues[0].message}` };
      }
      return { name: 'config', status: 'ok', message: '.docrelay/config.yaml found and valid' };
    } catch (err: any) {
      // Log the full error so operators can diagnose; the client message
      // stays generic (parse errors may embed absolute paths).
      console.error('Config parse failed:', err instanceof Error ? err.message : err);
      return { name: 'config', status: 'failed', code: ErrorCode.CONFIG_PARSE_FAILED, message: 'config.yaml failed to parse — run docrelay config validate for details' };
    }
  });

  // 3. .docrelay/ directory writable
  await run('docrelay_dir_writable', async () => {
    const docrelayDir = path.join(projectRoot, '.docrelay');
    try {
      fs.accessSync(docrelayDir, fs.constants.W_OK);
      return { name: 'docrelay_dir_writable', status: 'ok', message: '.docrelay/ is writable' };
    } catch {
      return { name: 'docrelay_dir_writable', status: 'failed', code: ErrorCode.FS_PERMISSION_DENIED, message: '.docrelay/ is not writable — check directory permissions' };
    }
  });

  // 4. Database file writable (the DB lives in the git dir — a read-only
  // .git, e.g. in restricted CI checkouts, fails every write)
  await run('db_writable', async () => {
    // better-sqlite3 exposes the open database file path as .name.
    const dbFile = (db as unknown as { name?: string }).name ?? '';
    try {
      fs.accessSync(dbFile, fs.constants.W_OK);
      // WAL sidecar files (-wal/-shm) are created in the same directory.
      fs.accessSync(path.dirname(dbFile), fs.constants.W_OK);
      return { name: 'db_writable', status: 'ok', message: 'Database file is writable' };
    } catch {
      return { name: 'db_writable', status: 'failed', code: ErrorCode.FS_PERMISSION_DENIED, message: 'Database file or its directory is read-only — check permissions (the DB usually lives in the git dir)' };
    }
  });

  // 5. Schema version (a newer-than-supported DB fails cryptically
  // elsewhere; report it explicitly with remediation)
  await run('schema_version', async () => {
    const v = db.pragma('user_version', { simple: true }) as number;
    if (v > SCHEMA_VERSION) {
      return { name: 'schema_version', status: 'failed', code: ErrorCode.INTERNAL_UNEXPECTED, message: `Database schema v${v} is newer than this DocRelay supports (v${SCHEMA_VERSION}) — upgrade DocRelay` };
    }
    if (v < SCHEMA_VERSION) {
      return { name: 'schema_version', status: 'degraded', message: `Database schema v${v} is outdated (current v${SCHEMA_VERSION}) — migrations run automatically on the next command` };
    }
    return { name: 'schema_version', status: 'ok', message: `Schema v${v} (current)` };
  });

  // 6. Codegraph availability (with 5s timeout to prevent hangs)
  await run('codegraph', async () => {
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const available = await Promise.race([
        checkCodegraph(),
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CODEGRAPH_HEALTH_TIMEOUT_MS);
        }),
      ]);
      const latencyMs = Date.now() - start;
      if (available) {
        return { name: 'codegraph', status: 'ok', message: 'Codegraph is reachable', latencyMs };
      }
      return { name: 'codegraph', status: 'degraded', code: ErrorCode.CG_UNAVAILABLE, message: 'Codegraph is not available — falling back to builtin extractor', latencyMs };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      // Log the full error so operators can diagnose; return a sanitized
      // message to clients to avoid leaking paths or stack details.
      console.error('Codegraph check failed:', err instanceof Error ? err.message : err);
      return { name: 'codegraph', status: 'degraded', code: ErrorCode.CG_UNAVAILABLE, message: 'Internal error during health check — check server logs', latencyMs };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // 5. Symbol count
  await run('symbols', async () => {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c;
    if (count > 0) {
      return { name: 'symbols', status: 'ok', message: `${count} symbols tracked` };
    }
    return { name: 'symbols', status: 'degraded', message: 'No symbols tracked — run docrelay scan' };
  });

  // 6. Doc section count
  await run('docs', async () => {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM doc_sections').get() as { c: number }).c;
    if (count > 0) {
      return { name: 'docs', status: 'ok', message: `${count} doc sections tracked` };
    }
    return { name: 'docs', status: 'degraded', message: 'No doc sections tracked — run docrelay scan' };
  });

  // 7. Stale doc ratio
  await run('stale_docs', async () => {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM doc_sections').get() as { c: number }).c;
    if (total === 0) return { name: 'stale_docs', status: 'ok', message: 'No docs to check' };
    const stale = (db.prepare("SELECT COUNT(*) AS c FROM doc_sections WHERE status = 'stale'").get() as { c: number }).c;
    const ratio = stale / total;
    if (ratio === 0) return { name: 'stale_docs', status: 'ok', message: 'All docs in sync' };
    if (ratio < 0.1) return { name: 'stale_docs', status: 'degraded', message: `${stale}/${total} docs stale (${Math.round(ratio * 100)}%) — run docrelay sync` };
    return { name: 'stale_docs', status: 'failed', code: ErrorCode.SYNC_PARTIAL, message: `${stale}/${total} docs stale (${Math.round(ratio * 100)}%) — documentation is significantly out of date` };
  });

  // 8. Last scan timestamp
  await run('last_scan', async () => {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_scan_at'").get() as { value: string } | undefined;
    if (row?.value) {
      // Accept both the legacy SQLite UTC format and ISO-8601 (what the
      // scanner writes now) — the naive replace(' ','T')+'Z' trick corrupts
      // ISO input into a double-Z invalid date, falsely reporting 'Never
      // scanned' right after a successful scan.
      const scanMs = parseLastScanAt(row.value);
      if (scanMs !== undefined) {
        const hours = Math.round((Date.now() - scanMs) / 3600000);
        if (hours < 24) return { name: 'last_scan', status: 'ok', message: `Last scan ${hours}h ago` };
        return { name: 'last_scan', status: 'degraded', message: `Last scan ${hours}h ago — consider re-scanning` };
      }
    }
    return { name: 'last_scan', status: 'degraded', message: 'Never scanned — run docrelay scan' };
  });

  // 9. Pending changelog entries awaiting sync
  await run('pending_changes', async () => {
    const pending = (db.prepare("SELECT COUNT(*) AS c FROM changelog WHERE sync_status = 'pending'").get() as { c: number }).c;
    if (pending === 0) return { name: 'pending_changes', status: 'ok', message: 'No pending changes' };
    return { name: 'pending_changes', status: 'degraded', message: `${pending} change(s) awaiting sync — run docrelay sync` };
  });

  // 10. Git hooks installed and executable
  await run('hooks', async () => {
    const preCommit = path.join(resolveGitDir(projectRoot), 'hooks', 'pre-commit');
    try {
      fs.accessSync(preCommit, fs.constants.X_OK);
      return { name: 'hooks', status: 'ok', message: 'Git hooks installed' };
    } catch {
      return { name: 'hooks', status: 'degraded', message: 'Git hooks not installed (or not executable) — run docrelay install-hooks' };
    }
  });

  // 11. Orphaned mappings (integrity drift a gc run would clean up)
  await run('orphan_mappings', async () => {
    const orphans = (db.prepare(`
      SELECT COUNT(*) AS c FROM mappings m
      LEFT JOIN symbols s ON s.id = m.symbol_id
      LEFT JOIN doc_sections d ON d.id = m.doc_id
      WHERE s.id IS NULL OR d.id IS NULL
    `).get() as { c: number }).c;
    if (orphans === 0) return { name: 'orphan_mappings', status: 'ok', message: 'No orphaned mappings' };
    return { name: 'orphan_mappings', status: 'degraded', message: `${orphans} mapping(s) reference missing symbols or docs — run docrelay gc` };
  });

  // Aggregate results and log failures
  const failed = checks.filter(c => c.status === 'failed');
  const degraded = checks.filter(c => c.status === 'degraded');
  const healthy = failed.length === 0;

  for (const c of failed) {
    errors.push({ code: c.code ?? ErrorCode.INTERNAL_UNEXPECTED, message: c.message });
    // Log structured errors so monitoring/alerting systems can scan for them.
    // c.code originates from ErrorCode constants in this file, so the cast is
    // safe at runtime — use ?? to handle the undefined case explicitly.
    const errorCode: ErrorCode = (c.code ?? ErrorCode.INTERNAL_UNEXPECTED) as ErrorCode;
    logError(docrelayError(
      errorCode,
      c.message,
      `health check: ${c.name}`,
      false,
    ));
  }

  let summary: string;
  if (healthy && degraded.length === 0) {
    summary = 'All systems healthy.';
  } else if (healthy) {
    summary = `${degraded.length} check(s) degraded — system is functional with reduced capability.`;
  } else {
    summary = `${failed.length} check(s) failed, ${degraded.length} degraded — documentation sync may be impaired.`;
  }

  return {
    healthy,
    timestamp: new Date().toISOString(),
    version,
    checks,
    errors,
    summary,
  };
}
