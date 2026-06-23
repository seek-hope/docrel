import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 2;

export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion >= SCHEMA_VERSION) return;

  // Add raw_signature column for existing V1 databases (outside transaction)
  if (currentVersion >= 1) {
    try {
      db.exec('ALTER TABLE symbols ADD COLUMN raw_signature TEXT NOT NULL DEFAULT \'\'');
    } catch {
      // Column already exists or table doesn't exist yet
    }
  }

  // Wrap in a transaction so migration is atomic — partial failure
  // won't leave the database in a half-migrated state.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK(kind IN ('function','class','module','api_endpoint','type','interface','variable')),
        project       TEXT NOT NULL DEFAULT '',
        location      TEXT NOT NULL DEFAULT '',
        signature     TEXT NOT NULL DEFAULT '',
        raw_signature TEXT NOT NULL DEFAULT '',
        metadata      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS doc_sections (
        id           TEXT PRIMARY KEY,
        file         TEXT NOT NULL,
        anchor       TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        doc_type     TEXT NOT NULL CHECK(doc_type IN ('inline','standalone','generated','architecture')),
        status       TEXT NOT NULL DEFAULT 'in_sync' CHECK(status IN ('in_sync','stale','draft')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS mappings (
        symbol_id  TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        doc_id     TEXT NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE,
        rel_type   TEXT NOT NULL CHECK(rel_type IN ('describes','references','generates','contracts')),
        confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (symbol_id, doc_id, rel_type)
      );

      CREATE INDEX IF NOT EXISTS idx_mappings_symbol ON mappings(symbol_id);
      CREATE INDEX IF NOT EXISTS idx_mappings_doc ON mappings(doc_id);

      CREATE TABLE IF NOT EXISTS changelog (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
        symbol_id     TEXT NOT NULL,
        change_type   TEXT NOT NULL CHECK(change_type IN ('signature_changed','moved','renamed','deleted','created')),
        old_sig       TEXT NOT NULL DEFAULT '',
        new_sig       TEXT NOT NULL DEFAULT '',
        affected_docs TEXT NOT NULL DEFAULT '[]',
        sync_status   TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','applied','failed'))
      );

      CREATE INDEX IF NOT EXISTS idx_changelog_symbol ON changelog(symbol_id);
      CREATE INDEX IF NOT EXISTS idx_changelog_status ON changelog(sync_status);
    `);

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
