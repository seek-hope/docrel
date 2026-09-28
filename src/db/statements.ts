// src/db/statements.ts — per-database prepared-statement cache.
import type Database from 'better-sqlite3';

/**
 * better-sqlite3 compiles SQL on every prepare() call. Hot helpers
 * (upsertSymbol, upsertDocSection, createMapping, …) run thousands of times
 * per scan, so compiling the same SQL text on every call measurably
 * dominates ingest/link time on large projects. This cache keeps one
 * compiled Statement per (database, SQL text) pair.
 *
 * Safety notes:
 * - Keyed by the Database handle in a WeakMap, so closed/abandoned
 *   connections (and their statements) are garbage-collected normally.
 * - Statements are safe to reuse across transactions in better-sqlite3.
 * - Running a statement after its db was closed throws, same as preparing
 *   fresh SQL on a closed db — error behavior is preserved.
 */
const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function cachedStmt(db: Database.Database, sql: string): Database.Statement {
  let bySql = cache.get(db);
  if (!bySql) {
    bySql = new Map();
    cache.set(db, bySql);
  }
  let stmt = bySql.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    bySql.set(sql, stmt);
  }
  return stmt;
}
