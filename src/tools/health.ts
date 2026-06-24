/**
 * docrel_health — comprehensive system health check.
 * Checks database connectivity, codegraph availability, filesystem access,
 * and reports any detected error conditions with structured error codes.
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode } from '../utils/error-codes.js';

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

export async function docrelHealth(
  db: Database.Database,
  projectRoot: string,
  checkCodegraph: () => Promise<boolean>,
  version: string,
): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  const errors: Array<{ code: string; message: string }> = [];

  const run = async (fn: HealthCheckFn) => {
    try {
      checks.push(await fn());
    } catch (err: any) {
      checks.push({
        name: 'unknown',
        status: 'failed',
        code: ErrorCode.INTERNAL_UNEXPECTED,
        message: `Health check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // 1. Database connectivity
  await run(async () => {
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
      return { name: 'database', status: 'failed', code: ErrorCode.DB_CONNECTION_FAILED, message: `Cannot query database: ${err instanceof Error ? err.message : String(err)}`, latencyMs };
    }
  });

  // 2. DocRel config existence
  await run(async () => {
    const configPath = path.join(projectRoot, '.docrel', 'config.yaml');
    if (fs.existsSync(configPath)) {
      return { name: 'config', status: 'ok', message: '.docrel/config.yaml found' };
    }
    return { name: 'config', status: 'failed', code: ErrorCode.CONFIG_MISSING, message: '.docrel/config.yaml not found — run docrel init' };
  });

  // 3. .docrel/ directory writable
  await run(async () => {
    const docrelDir = path.join(projectRoot, '.docrel');
    try {
      fs.accessSync(docrelDir, fs.constants.W_OK);
      return { name: 'docrel_dir_writable', status: 'ok', message: '.docrel/ is writable' };
    } catch {
      return { name: 'docrel_dir_writable', status: 'failed', code: ErrorCode.FS_PERMISSION_DENIED, message: '.docrel/ is not writable — check directory permissions' };
    }
  });

  // 4. Codegraph availability
  await run(async () => {
    const start = Date.now();
    try {
      const available = await checkCodegraph();
      const latencyMs = Date.now() - start;
      if (available) {
        return { name: 'codegraph', status: 'ok', message: 'Codegraph is reachable', latencyMs };
      }
      return { name: 'codegraph', status: 'degraded', code: ErrorCode.CG_UNAVAILABLE, message: 'Codegraph is not available — falling back to builtin extractor', latencyMs };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return { name: 'codegraph', status: 'degraded', code: ErrorCode.CG_UNAVAILABLE, message: `Codegraph check failed: ${err instanceof Error ? err.message : String(err)}`, latencyMs };
    }
  });

  // 5. Symbol count
  await run(async () => {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c;
    if (count > 0) {
      return { name: 'symbols', status: 'ok', message: `${count} symbols tracked` };
    }
    return { name: 'symbols', status: 'degraded', message: 'No symbols tracked — run docrel scan' };
  });

  // 6. Doc section count
  await run(async () => {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM doc_sections').get() as { c: number }).c;
    if (count > 0) {
      return { name: 'docs', status: 'ok', message: `${count} doc sections tracked` };
    }
    return { name: 'docs', status: 'degraded', message: 'No doc sections tracked — run docrel scan' };
  });

  // 7. Stale doc ratio
  await run(async () => {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM doc_sections').get() as { c: number }).c;
    if (total === 0) return { name: 'stale_docs', status: 'ok', message: 'No docs to check' };
    const stale = (db.prepare("SELECT COUNT(*) AS c FROM doc_sections WHERE status = 'stale'").get() as { c: number }).c;
    const ratio = stale / total;
    if (ratio === 0) return { name: 'stale_docs', status: 'ok', message: 'All docs in sync' };
    if (ratio < 0.1) return { name: 'stale_docs', status: 'degraded', message: `${stale}/${total} docs stale (${Math.round(ratio * 100)}%) — run docrel sync` };
    return { name: 'stale_docs', status: 'failed', code: ErrorCode.SYNC_PARTIAL, message: `${stale}/${total} docs stale (${Math.round(ratio * 100)}%) — documentation is significantly out of date` };
  });

  // 8. Last scan timestamp
  await run(async () => {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_scan_at'").get() as { value: string } | undefined;
    if (row?.value) {
      const age = Date.now() - new Date(row.value.replace(' ', 'T') + 'Z').getTime();
      const hours = Math.round(age / 3600000);
      if (hours < 24) return { name: 'last_scan', status: 'ok', message: `Last scan ${hours}h ago` };
      return { name: 'last_scan', status: 'degraded', message: `Last scan ${hours}h ago — consider re-scanning` };
    }
    return { name: 'last_scan', status: 'degraded', message: 'Never scanned — run docrel scan' };
  });

  // Aggregate
  const failed = checks.filter(c => c.status === 'failed');
  const degraded = checks.filter(c => c.status === 'degraded');
  const healthy = failed.length === 0;

  for (const c of failed) {
    errors.push({ code: c.code ?? ErrorCode.INTERNAL_UNEXPECTED, message: c.message });
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
