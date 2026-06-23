# DocRel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build DocRel — an MCP Server + CLI that uses database concepts (foreign keys, CASCADE, CHECK constraints) and Codegraph symbol intelligence to keep code and documentation in sync automatically.

**Architecture:** A TypeScript MCP server exposes 6 tools to coding agents. A SQLite database (`.git/docrel.db`) stores symbol-to-document mappings. Codegraph provides symbol tracking via its MCP interface. Git hooks enforce doc-sync integrity at commit/push boundaries.

**Tech Stack:** TypeScript 5.x, @modelcontextprotocol/sdk, better-sqlite3, vitest, commander, chokidar, simple-git

## Global Constraints

- Node.js >= 20
- TypeScript target: ES2023, module: NodeNext
- All MCP tools must have CLI fallback equivalents
- Database file: `.git/docrel.db` (per-repo)
- Config directory: `.docrel/` (per-repo)
- Stable symbol IDs: `SHA256("language:fqn:kind")`
- No external service dependencies (everything is local)
- Zero-annotation: users never annotate code manually
- Tests use vitest with AAA pattern

---

## File Structure Map

```
docrel/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts               # MCP server entry, registers all tools
│   ├── cli.ts                  # CLI entry (commander), mirrors all tools
│   ├── db/
│   │   ├── connection.ts       # SQLite connection singleton
│   │   ├── schema.ts           # CREATE TABLE statements, migrations
│   │   ├── symbols.ts          # CRUD for symbols table
│   │   ├── docs.ts             # CRUD for doc_sections table
│   │   ├── mappings.ts         # CRUD for mappings (JOIN) table
│   │   └── changelog.ts        # CRUD for changelog table
│   ├── codegraph/
│   │   └── client.ts           # MCP client wrapper for codegraph server
│   ├── sync/
│   │   ├── engine.ts           # CASCADE orchestrator (routes by doc_type)
│   │   ├── inline.ts           # Docstring/JSDoc updater
│   │   ├── standalone.ts       # Markdown section rewriter
│   │   └── generated.ts        # Generator trigger (TypeDoc, OpenAPI, etc.)
│   ├── discovery/
│   │   ├── scanner.ts          # Auto-discover symbols from codegraph index
│   │   └── doc-parser.ts       # Parse docs for code references, build mappings
│   ├── git/
│   │   └── hooks.ts            # pre-commit, post-commit, pre-push logic
│   ├── tools/
│   │   ├── impact.ts           # docrel_impact handler
│   │   ├── sync.ts             # docrel_sync handler
│   │   ├── check.ts            # docrel_check handler
│   │   ├── link.ts             # docrel_link handler
│   │   ├── status.ts           # docrel_status handler
│   │   └── diff.ts             # docrel_diff handler
│   └── utils/
│       ├── hash.ts             # SHA256 stable ID generator
│       └── config.ts           # .docrel/config.yaml reader
├── tests/
│   ├── db/
│   │   ├── schema.test.ts
│   │   ├── symbols.test.ts
│   │   └── mappings.test.ts
│   ├── sync/
│   │   ├── engine.test.ts
│   │   └── inline.test.ts
│   ├── tools/
│   │   ├── impact.test.ts
│   │   ├── status.test.ts
│   │   └── check.test.ts
│   └── integration/
│       └── e2e.test.ts
├── scripts/
│   └── install-hooks.sh
└── fixtures/
    ├── sample-project/
    │   ├── src/
    │   │   └── auth.ts
    │   └── docs/
    │       └── api.md
    └── expected/
        └── api-synced.md
```

---

## Phase 0: Project Scaffolding

### Task 0: Initialize TypeScript project with all dependencies

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: Project ready for `npm install && npm test`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "docrel",
  "version": "0.1.0",
  "description": "Code-Documentation Relational Sync System",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "docrel": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/ tests/",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "chokidar": "^4.0.0",
    "commander": "^13.0.0",
    "simple-git": "^3.0.0",
    "yaml": "^2.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0",
    "eslint": "^9.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
*.db
*.db-journal
```

- [ ] **Step 5: Install and verify**

Run: `npm install`
Run: `npm test`
Expected: "No test files found" (no tests yet, but infra works)

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: initialize docrel project with TypeScript and vitest"
```

---

## Phase 1: Core Data Layer

### Task 1: Database connection singleton

**Files:**
- Create: `src/db/connection.ts`
- Create: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: `getDb(projectRoot: string): Database` — returns/creates SQLite connection, auto-creates `.git/docrel.db` directory

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('getDb', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates docrel.db inside .git directory', () => {
    const db = getDb(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.git', 'docrel.db'))).toBe(true);
  });

  it('returns the same connection on repeated calls', () => {
    const db1 = getDb(tmpDir);
    const db2 = getDb(tmpDir);
    expect(db1).toBe(db2);
  });

  it('sets WAL mode on the database', () => {
    const db = getDb(tmpDir);
    const result = db.pragma('journal_mode');
    expect(result).toBe('wal');
  });

  it('enables foreign keys', () => {
    const db = getDb(tmpDir);
    const result = db.pragma('foreign_keys');
    expect(result).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the connection module**

```typescript
// src/db/connection.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;
let currentRoot: string | null = null;

export function getDb(projectRoot: string): Database.Database {
  if (db && currentRoot === projectRoot) {
    return db;
  }

  closeDb();

  const gitDir = path.join(projectRoot, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const dbPath = path.join(gitDir, 'docrel.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  currentRoot = projectRoot;

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentRoot = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/connection.ts tests/db/schema.test.ts
git commit -m "feat: add database connection singleton with WAL mode"
```

---

### Task 2: Database schema creation and migrations

**Files:**
- Create: `src/db/schema.ts`
- Modify: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: `runMigrations(db: Database): void` — creates all 4 tables if not exist
- Produces: `SCHEMA_VERSION: number` — current schema version

- [ ] **Step 1: Add schema tests to existing test file**

Append to `tests/db/schema.test.ts`:

```typescript
import { runMigrations, SCHEMA_VERSION } from '../../src/db/schema.js';

describe('runMigrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all four tables: symbols, doc_sections, mappings, changelog', () => {
    const db = getDb(tmpDir);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain('symbols');
    expect(names).toContain('doc_sections');
    expect(names).toContain('mappings');
    expect(names).toContain('changelog');
  });

  it('is idempotent — running twice does not error', () => {
    const db = getDb(tmpDir);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('stores schema version in pragma', () => {
    const db = getDb(tmpDir);
    runMigrations(db);
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('mappings table has foreign keys to symbols and doc_sections', () => {
    const db = getDb(tmpDir);
    runMigrations(db);

    const foreignKeys = db
      .prepare("PRAGMA foreign_key_list('mappings')")
      .all() as { table: string }[];

    const tables = foreignKeys.map((fk) => fk.table);
    expect(tables).toContain('symbols');
    expect(tables).toContain('doc_sections');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL — `runMigrations` not found

- [ ] **Step 3: Write the schema module**

```typescript
// src/db/schema.ts
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK(kind IN ('function','class','module','api_endpoint','type','interface','variable')),
      project    TEXT NOT NULL DEFAULT '',
      location   TEXT NOT NULL DEFAULT '',
      signature  TEXT NOT NULL DEFAULT '',
      metadata   TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: add database schema with symbols, doc_sections, mappings, changelog tables"
```

---

### Task 3: Stable symbol ID generator

**Files:**
- Create: `src/utils/hash.ts`
- Create: `tests/db/symbols.test.ts`

**Interfaces:**
- Produces: `symbolId(language: string, fqn: string, kind: string): string` — SHA256 hash used as primary key
- Produces: `docSectionId(file: string, anchor: string): string` — SHA256 hash for doc sections

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/symbols.test.ts
import { describe, it, expect } from 'vitest';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import crypto from 'node:crypto';

describe('symbolId', () => {
  it('generates a stable 64-char hex string', () => {
    const id = symbolId('typescript', 'src/auth::login', 'function');
    expect(id).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(id)).toBe(true);
  });

  it('is deterministic — same inputs produce same id', () => {
    const a = symbolId('typescript', 'src/auth::login', 'function');
    const b = symbolId('typescript', 'src/auth::login', 'function');
    expect(a).toBe(b);
  });

  it('differs when language differs', () => {
    const ts = symbolId('typescript', 'login', 'function');
    const py = symbolId('python', 'login', 'function');
    expect(ts).not.toBe(py);
  });

  it('differs when kind differs', () => {
    const fn = symbolId('typescript', 'login', 'function');
    const cls = symbolId('typescript', 'login', 'class');
    expect(fn).not.toBe(cls);
  });

  it('normalizes FQN whitespace', () => {
    const a = symbolId('typescript', '  src/auth::login  ', 'function');
    const b = symbolId('typescript', 'src/auth::login', 'function');
    expect(a).toBe(b);
  });
});

describe('docSectionId', () => {
  it('generates a stable 64-char hex string', () => {
    const id = docSectionId('docs/api.md', 'authentication');
    expect(id).toHaveLength(64);
  });

  it('is deterministic', () => {
    const a = docSectionId('docs/api.md', 'authentication');
    const b = docSectionId('docs/api.md', 'authentication');
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Write the hash module**

```typescript
// src/utils/hash.ts
import crypto from 'node:crypto';

export function symbolId(language: string, fqn: string, kind: string): string {
  const normalized = `${language.trim().toLowerCase()}:${fqn.trim()}:${kind.trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function docSectionId(file: string, anchor: string): string {
  const normalized = `${file.trim()}#${anchor.trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run tests/db/symbols.test.ts`
Expected: 7 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/hash.ts tests/db/symbols.test.ts
git commit -m "feat: add stable symbol ID and doc section ID generators"
```

---

### Task 4: CRUD operations for symbols table

**Files:**
- Create: `src/db/symbols.ts`
- Append to: `tests/db/symbols.test.ts`

**Interfaces:**
- Produces: `upsertSymbol(db, params): SymbolRow` — insert or update a symbol
- Produces: `getSymbol(db, id): SymbolRow | undefined`
- Produces: `listSymbols(db, filter?): SymbolRow[]`
- Produces: `deleteSymbol(db, id): void`
- Produces: `markSignatureChanged(db, id, oldSig, newSig): void`

- [ ] **Step 1: Add tests to symbols.test.ts**

```typescript
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol, getSymbol, listSymbols, deleteSymbol, markSignatureChanged } from '../../src/db/symbols.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('symbols CRUD', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const testSymbol = {
    id: symbolId('typescript', 'src/auth::login', 'function'),
    name: 'login',
    kind: 'function' as const,
    project: 'src/auth',
    location: 'src/auth.ts:42',
    signature: 'abc123',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('upsertSymbol', () => {
    it('inserts a new symbol', () => {
      const row = upsertSymbol(db, testSymbol);
      expect(row.id).toBe(testSymbol.id);
      expect(row.name).toBe('login');
    });

    it('updates an existing symbol by id', () => {
      upsertSymbol(db, testSymbol);
      const updated = upsertSymbol(db, { ...testSymbol, location: 'src/auth.ts:88', signature: 'def456' });
      expect(updated.location).toBe('src/auth.ts:88');
      expect(updated.signature).toBe('def456');

      const fetched = getSymbol(db, testSymbol.id);
      expect(fetched?.signature).toBe('def456');
    });
  });

  describe('getSymbol', () => {
    it('returns undefined for non-existent symbol', () => {
      expect(getSymbol(db, 'nonexistent')).toBeUndefined();
    });

    it('returns the inserted symbol', () => {
      upsertSymbol(db, testSymbol);
      const row = getSymbol(db, testSymbol.id);
      expect(row).toBeDefined();
      expect(row!.name).toBe('login');
    });
  });

  describe('listSymbols', () => {
    it('returns all symbols when no filter', () => {
      upsertSymbol(db, testSymbol);
      upsertSymbol(db, { ...testSymbol, id: symbolId('typescript', 'src/auth::logout', 'function'), name: 'logout' });
      expect(listSymbols(db)).toHaveLength(2);
    });

    it('filters by kind', () => {
      upsertSymbol(db, testSymbol);
      upsertSymbol(db, { ...testSymbol, id: symbolId('typescript', 'Auth', 'class'), name: 'Auth', kind: 'class' });
      expect(listSymbols(db, { kind: 'class' })).toHaveLength(1);
    });

    it('filters by project', () => {
      upsertSymbol(db, testSymbol);
      upsertSymbol(db, { ...testSymbol, id: symbolId('typescript', 'other::fn', 'function'), project: 'other' });
      expect(listSymbols(db, { project: 'src/auth' })).toHaveLength(1);
    });
  });

  describe('deleteSymbol', () => {
    it('removes the symbol from the database', () => {
      upsertSymbol(db, testSymbol);
      deleteSymbol(db, testSymbol.id);
      expect(getSymbol(db, testSymbol.id)).toBeUndefined();
    });
  });

  describe('markSignatureChanged', () => {
    it('records a changelog entry and updates the symbol signature', () => {
      upsertSymbol(db, testSymbol);
      markSignatureChanged(db, testSymbol.id, 'abc123', 'new456');

      const updated = getSymbol(db, testSymbol.id);
      expect(updated?.signature).toBe('new456');

      const log = db.prepare('SELECT * FROM changelog WHERE symbol_id = ?').get(testSymbol.id) as any;
      expect(log.change_type).toBe('signature_changed');
      expect(log.old_sig).toBe('abc123');
      expect(log.new_sig).toBe('new456');
    });
  });
});
```

- [ ] **Step 2: Write the symbols module**

```typescript
// src/db/symbols.ts
import type Database from 'better-sqlite3';

export interface SymbolRow {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable';
  project: string;
  location: string;
  signature: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface SymbolInput {
  id: string;
  name: string;
  kind: SymbolRow['kind'];
  project?: string;
  location?: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}

export function upsertSymbol(db: Database.Database, input: SymbolInput): SymbolRow {
  const existing = db.prepare('SELECT id FROM symbols WHERE id = ?').get(input.id);

  if (existing) {
    db.prepare(`
      UPDATE symbols
      SET name = ?, kind = ?, project = ?, location = ?, signature = ?,
          metadata = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.name,
      input.kind,
      input.project ?? '',
      input.location ?? '',
      input.signature ?? '',
      JSON.stringify(input.metadata ?? {}),
      input.id,
    );
  } else {
    db.prepare(`
      INSERT INTO symbols (id, name, kind, project, location, signature, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.kind,
      input.project ?? '',
      input.location ?? '',
      input.signature ?? '',
      JSON.stringify(input.metadata ?? {}),
    );
  }

  return getSymbol(db, input.id)!;
}

export function getSymbol(db: Database.Database, id: string): SymbolRow | undefined {
  return db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
}

export interface SymbolFilter {
  kind?: string;
  project?: string;
}

export function listSymbols(db: Database.Database, filter?: SymbolFilter): SymbolRow[] {
  let query = 'SELECT * FROM symbols WHERE 1=1';
  const params: string[] = [];

  if (filter?.kind) {
    query += ' AND kind = ?';
    params.push(filter.kind);
  }
  if (filter?.project) {
    query += ' AND project = ?';
    params.push(filter.project);
  }

  query += ' ORDER BY project, name';
  return db.prepare(query).all(...params) as SymbolRow[];
}

export function deleteSymbol(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM symbols WHERE id = ?').run(id);
}

export function markSignatureChanged(
  db: Database.Database,
  id: string,
  oldSig: string,
  newSig: string,
): void {
  db.prepare("UPDATE symbols SET signature = ?, updated_at = datetime('now') WHERE id = ?").run(newSig, id);

  db.prepare(`
    INSERT INTO changelog (symbol_id, change_type, old_sig, new_sig)
    VALUES (?, 'signature_changed', ?, ?)
  `).run(id, oldSig, newSig);
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run tests/db/symbols.test.ts`
Expected: 14 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/db/symbols.ts tests/db/symbols.test.ts
git commit -m "feat: add symbols table CRUD with signature change tracking"
```

---

### Task 5: CRUD operations for doc_sections and mappings tables

**Files:**
- Create: `src/db/docs.ts`
- Create: `src/db/mappings.ts`
- Create: `tests/db/mappings.test.ts`

**Interfaces:**
- Produces: `upsertDocSection(db, params): DocSectionRow`
- Produces: `getDocSection(db, id): DocSectionRow | undefined`
- Produces: `listDocSections(db, filter?): DocSectionRow[]`
- Produces: `markDocStale(db, id): void`
- Produces: `createMapping(db, params): MappingRow`
- Produces: `getMappingsForSymbol(db, symbolId): MappingRow[]`
- Produces: `getMappingsForDoc(db, docId): MappingRow[]`
- Produces: `deleteMapping(db, symbolId, docId, relType): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/mappings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection, markDocStale } from '../../src/db/docs.js';
import {
  createMapping,
  getMappingsForSymbol,
  getMappingsForDoc,
  deleteMapping,
} from '../../src/db/mappings.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('doc_sections and mappings CRUD', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  const symId = symbolId('typescript', 'src/auth::login', 'function');
  const docId = docSectionId('docs/api.md', 'authentication');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42', signature: 'abc' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'authentication', doc_type: 'standalone' });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('doc_sections', () => {
    it('upserts and retrieves a doc section', () => {
      const doc = getDocSection(db, docId);
      expect(doc).toBeDefined();
      expect(doc!.file).toBe('docs/api.md');
      expect(doc!.doc_type).toBe('standalone');
    });

    it('markDocStale sets status to stale', () => {
      markDocStale(db, docId);
      const doc = getDocSection(db, docId);
      expect(doc!.status).toBe('stale');
    });
  });

  describe('mappings', () => {
    it('creates a mapping between symbol and doc', () => {
      const mapping = createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      expect(mapping.symbol_id).toBe(symId);
      expect(mapping.doc_id).toBe(docId);
      expect(mapping.rel_type).toBe('describes');
    });

    it('returns mappings for a symbol', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      const mappings = getMappingsForSymbol(db, symId);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].doc_id).toBe(docId);
    });

    it('returns mappings for a doc', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      const mappings = getMappingsForDoc(db, docId);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].symbol_id).toBe(symId);
    });

    it('deletes a specific mapping', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      deleteMapping(db, symId, docId, 'describes');
      expect(getMappingsForSymbol(db, symId)).toHaveLength(0);
    });

    it('cascades delete when symbol is deleted', () => {
      createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
      db.prepare('DELETE FROM symbols WHERE id = ?').run(symId);
      expect(getMappingsForSymbol(db, symId)).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Write docs.ts module**

```typescript
// src/db/docs.ts
import type Database from 'better-sqlite3';

export interface DocSectionRow {
  id: string;
  file: string;
  anchor: string;
  content_hash: string;
  doc_type: 'inline' | 'standalone' | 'generated' | 'architecture';
  status: 'in_sync' | 'stale' | 'draft';
  created_at: string;
  updated_at: string;
}

export interface DocSectionInput {
  id: string;
  file: string;
  anchor?: string;
  content_hash?: string;
  doc_type: DocSectionRow['doc_type'];
  status?: DocSectionRow['status'];
}

export function upsertDocSection(db: Database.Database, input: DocSectionInput): DocSectionRow {
  const existing = db.prepare('SELECT id FROM doc_sections WHERE id = ?').get(input.id);

  if (existing) {
    db.prepare(`
      UPDATE doc_sections
      SET file = ?, anchor = ?, content_hash = ?, doc_type = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(input.file, input.anchor ?? '', input.content_hash ?? '', input.doc_type, input.status ?? 'in_sync', input.id);
  } else {
    db.prepare(`
      INSERT INTO doc_sections (id, file, anchor, content_hash, doc_type, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.file, input.anchor ?? '', input.content_hash ?? '', input.doc_type, input.status ?? 'in_sync');
  }

  return getDocSection(db, input.id)!;
}

export function getDocSection(db: Database.Database, id: string): DocSectionRow | undefined {
  return db.prepare('SELECT * FROM doc_sections WHERE id = ?').get(id) as DocSectionRow | undefined;
}

export function listDocSections(db: Database.Database, filter?: { doc_type?: string; status?: string }): DocSectionRow[] {
  let query = 'SELECT * FROM doc_sections WHERE 1=1';
  const params: string[] = [];

  if (filter?.doc_type) { query += ' AND doc_type = ?'; params.push(filter.doc_type); }
  if (filter?.status) { query += ' AND status = ?'; params.push(filter.status); }

  query += ' ORDER BY file, anchor';
  return db.prepare(query).all(...params) as DocSectionRow[];
}

export function markDocStale(db: Database.Database, id: string): void {
  db.prepare("UPDATE doc_sections SET status = 'stale', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function markDocSynced(db: Database.Database, id: string): void {
  db.prepare("UPDATE doc_sections SET status = 'in_sync', updated_at = datetime('now') WHERE id = ?").run(id);
}
```

- [ ] **Step 3: Write mappings.ts module**

```typescript
// src/db/mappings.ts
import type Database from 'better-sqlite3';

export interface MappingRow {
  symbol_id: string;
  doc_id: string;
  rel_type: 'describes' | 'references' | 'generates' | 'contracts';
  confidence: number;
  created_at: string;
}

export interface MappingInput {
  symbol_id: string;
  doc_id: string;
  rel_type: MappingRow['rel_type'];
  confidence?: number;
}

export function createMapping(db: Database.Database, input: MappingInput): MappingRow {
  db.prepare(`
    INSERT OR REPLACE INTO mappings (symbol_id, doc_id, rel_type, confidence)
    VALUES (?, ?, ?, ?)
  `).run(input.symbol_id, input.doc_id, input.rel_type, input.confidence ?? 1.0);

  return getMapping(db, input.symbol_id, input.doc_id, input.rel_type)!;
}

function getMapping(db: Database.Database, symbolId: string, docId: string, relType: string): MappingRow | undefined {
  return db.prepare(
    'SELECT * FROM mappings WHERE symbol_id = ? AND doc_id = ? AND rel_type = ?',
  ).get(symbolId, docId, relType) as MappingRow | undefined;
}

export function getMappingsForSymbol(db: Database.Database, symbolId: string): MappingRow[] {
  return db.prepare('SELECT * FROM mappings WHERE symbol_id = ?').all(symbolId) as MappingRow[];
}

export function getMappingsForDoc(db: Database.Database, docId: string): MappingRow[] {
  return db.prepare('SELECT * FROM mappings WHERE doc_id = ?').all(docId) as MappingRow[];
}

export function listAllMappings(db: Database.Database): MappingRow[] {
  return db.prepare('SELECT * FROM mappings ORDER BY symbol_id').all() as MappingRow[];
}

export function deleteMapping(db: Database.Database, symbolId: string, docId: string, relType: string): void {
  db.prepare('DELETE FROM mappings WHERE symbol_id = ? AND doc_id = ? AND rel_type = ?').run(symbolId, docId, relType);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/mappings.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (29 across 3 test files)

- [ ] **Step 6: Commit**

```bash
git add src/db/docs.ts src/db/mappings.ts tests/db/mappings.test.ts
git commit -m "feat: add doc_sections and mappings CRUD with foreign key cascade"
```

---

### Task 6: Config reader for .docrel/config.yaml

**Files:**
- Create: `src/utils/config.ts`
- Create: `fixtures/sample-project/.docrel/config.yaml`

**Interfaces:**
- Produces: `loadConfig(projectRoot: string): DocRelConfig`
- Produces: `DocRelConfig` type: `{ project: string, doc_dirs: string[], code_dirs: string[], strategies: {...} }`

- [ ] **Step 1: Write the config module**

```typescript
// src/utils/config.ts
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface DocRelConfig {
  project: string;
  doc_dirs: string[];
  code_dirs: string[];
  strategies: {
    inline: 'auto_update' | 'mark_stale';
    standalone: 'auto_update' | 'mark_stale' | 'prompt';
    generated: 'auto_update' | 'mark_stale';
    architecture: 'mark_stale' | 'ignore';
  };
  codegraph?: {
    command?: string;
    mcpServerName?: string;
  };
}

const DEFAULT_CONFIG: DocRelConfig = {
  project: path.basename(process.cwd()),
  doc_dirs: ['docs', 'README.md'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'auto_update',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

export function loadConfig(projectRoot: string): DocRelConfig {
  const configPath = path.join(projectRoot, '.docrel', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, project: path.basename(projectRoot) };
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const userConfig = parseYaml(raw) as Partial<DocRelConfig>;

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    strategies: { ...DEFAULT_CONFIG.strategies, ...userConfig.strategies },
    codegraph: { ...DEFAULT_CONFIG.codegraph, ...userConfig.codegraph },
  };
}
```

- [ ] **Step 2: Create sample config fixture**

```yaml
# fixtures/sample-project/.docrel/config.yaml
project: sample-project
doc_dirs:
  - docs
  - README.md
code_dirs:
  - src
strategies:
  inline: auto_update
  standalone: auto_update
  generated: auto_update
  architecture: mark_stale
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/config.ts fixtures/
git commit -m "feat: add config reader with sensible defaults for .docrel/config.yaml"
```

---

## Phase 2: Codegraph Integration & Discovery

### Task 7: Codegraph MCP client wrapper

**Files:**
- Create: `src/codegraph/client.ts`

**Interfaces:**
- Produces: `CodegraphClient` class with:
  - `explore(query: string): Promise<ExploreResult>` — wrap codegraph_explore
  - `impact(symbol: string): Promise<ImpactResult>` — wrap codegraph_impact
  - `search(query: string): Promise<SearchResult>` — wrap codegraph_search
  - `isAvailable(): Promise<boolean>` — check if codegraph MCP server is reachable

- [ ] **Step 1: Write the codegraph client**

```typescript
// src/codegraph/client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface ExploreResult {
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    signature?: string;
  }>;
  files: string[];
}

export interface ImpactResult {
  symbol: string;
  affected: Array<{
    name: string;
    kind: string;
    file: string;
    relation: string;
  }>;
}

export interface SearchResult {
  items: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
  }>;
}

export class CodegraphClient {
  private client: Client | null = null;

  constructor(private command?: string) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const transport = new StdioClientTransport({
      command: this.command ?? 'codegraph',
      args: ['mcp'],
    });

    this.client = new Client(
      { name: 'docrel-codegraph-client', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    await this.client.connect(transport);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  async explore(query: string, maxFiles = 12): Promise<ExploreResult> {
    await this.connect();

    const result = await this.client!.callTool({
      name: 'codegraph_explore',
      arguments: { query, maxFiles },
    });

    const content = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return this.parseExploreOutput(content);
  }

  async impact(symbol: string, depth = 2): Promise<ImpactResult> {
    await this.connect();

    const result = await this.client!.callTool({
      name: 'codegraph_impact',
      arguments: { symbol, depth },
    });

    const content = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return this.parseImpactOutput(symbol, content);
  }

  async search(query: string, kind?: string): Promise<SearchResult> {
    await this.connect();

    const args: Record<string, unknown> = { query };
    if (kind) args.kind = kind;

    const result = await this.client!.callTool({
      name: 'codegraph_search',
      arguments: args,
    });

    const content = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return this.parseSearchOutput(content);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  private parseExploreOutput(content: string): ExploreResult {
    // Parse the markdown/code output from codegraph_explore
    // Extract symbol names, kinds, files, and line numbers
    const symbols: ExploreResult['symbols'] = [];
    const files: string[] = [];

    const fileRegex = /^## .*?(\S+\.\w+)/gm;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(content)) !== null) {
      if (!files.includes(match[1])) files.push(match[1]);
    }

    const symbolRegex = /(?:function|class|interface|type|const|method)\s+(\w+)/g;
    while ((match = symbolRegex.exec(content)) !== null) {
      // Extract surrounding context for file/line
      symbols.push({ name: match[1], kind: 'function', file: '', line: 0 });
    }

    return { symbols, files };
  }

  private parseImpactOutput(symbol: string, content: string): ImpactResult {
    const affected: ImpactResult['affected'] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      // Parse lines like "symbol_name (kind) in file.ts:line"
      const match = line.match(/(\w+)\s*\((\w+)\)\s*(?:in\s+)?(\S+):(\d+)/);
      if (match) {
        affected.push({ name: match[1], kind: match[2], file: match[3], relation: 'depends_on' });
      }
    }

    return { symbol, affected };
  }

  private parseSearchOutput(content: string): SearchResult {
    const items: SearchResult['items'] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/(\w+)\s*\((\w+)\)\s*in\s+(\S+):(\d+)/);
      if (match) {
        items.push({ name: match[1], kind: match[2], file: match[3], line: parseInt(match[4]) });
      }
    }

    return { items };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/codegraph/client.ts
git commit -m "feat: add codegraph MCP client wrapper for explore, impact, and search"
```

---

### Task 8: Auto-discovery scanner

**Files:**
- Create: `src/discovery/scanner.ts`

**Interfaces:**
- Produces: `scanProject(codegraph: CodegraphClient, db: Database, config: DocRelConfig): Promise<ScanReport>` — discovers all symbols via codegraph and populates symbols table
- Produces: `ScanReport` type: `{ totalSymbols: number, newSymbols: number, updatedSymbols: number }`

- [ ] **Step 1: Write the scanner**

```typescript
// src/discovery/scanner.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { upsertSymbol } from '../db/symbols.js';
import { symbolId, contentHash } from '../utils/hash.js';

export interface ScanReport {
  totalSymbols: number;
  newSymbols: number;
  updatedSymbols: number;
}

export async function scanProject(
  codegraph: CodegraphClient,
  db: Database.Database,
  config: DocRelConfig,
): Promise<ScanReport> {
  let newSymbols = 0;
  let updatedSymbols = 0;

  for (const codeDir of config.code_dirs) {
    // Use codegraph_explore to discover all symbols in each code directory
    const result = await codegraph.explore(`symbols in ${codeDir}/`, 50);

    for (const sym of result.symbols) {
      const lang = detectLanguage(sym.file);
      const fqn = `${sym.file}::${sym.name}`;
      const id = symbolId(lang, fqn, sym.kind);
      const sig = contentHash(sym.signature ?? sym.name);

      const existing = db.prepare('SELECT id, signature FROM symbols WHERE id = ?').get(id) as
        | { id: string; signature: string }
        | undefined;

      if (!existing) {
        upsertSymbol(db, {
          id,
          name: sym.name,
          kind: mapKind(sym.kind),
          project: codeDir,
          location: `${sym.file}:${sym.line}`,
          signature: sig,
        });
        newSymbols++;
      } else if (existing.signature !== sig) {
        upsertSymbol(db, {
          id,
          name: sym.name,
          kind: mapKind(sym.kind),
          location: `${sym.file}:${sym.line}`,
          signature: sig,
        });
        updatedSymbols++;
      }
    }
  }

  const total = db.prepare('SELECT COUNT(*) as count FROM symbols').get() as { count: number };

  return { totalSymbols: total.count, newSymbols, updatedSymbols };
}

function detectLanguage(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
    cs: 'csharp', cpp: 'cpp', c: 'c', swift: 'swift', kt: 'kotlin',
  };
  return langMap[ext ?? ''] ?? ext ?? 'unknown';
}

function mapKind(kind: string): 'function' | 'class' | 'module' | 'api_endpoint' | 'type' | 'interface' | 'variable' {
  const kindMap: Record<string, ReturnType<typeof mapKind>> = {
    function: 'function', method: 'function', func: 'function',
    class: 'class', struct: 'class',
    module: 'module', namespace: 'module',
    api_endpoint: 'api_endpoint', endpoint: 'api_endpoint', route: 'api_endpoint',
    type: 'type', interface: 'interface',
    variable: 'variable', const: 'variable', let: 'variable',
  };
  return kindMap[kind.toLowerCase()] ?? 'function';
}
```

- [ ] **Step 2: Commit**

```bash
git add src/discovery/scanner.ts
git commit -m "feat: add auto-discovery scanner using codegraph to populate symbols table"
```

---

## Phase 3: Sync Engine

### Task 9: CASCADE sync engine core

**Files:**
- Create: `src/sync/engine.ts`
- Create: `src/sync/inline.ts`
- Create: `src/sync/standalone.ts`
- Create: `src/sync/generated.ts`
- Create: `tests/sync/engine.test.ts`
- Create: `tests/sync/inline.test.ts`

**Interfaces:**
- Produces: `syncSymbol(db, codegraph, config, symbolId): Promise<SyncResult>` — main entry point
- Produces: `SyncResult` type: `{ symbolId, docsUpdated: string[], docsStaled: string[], errors: string[] }`

- [ ] **Step 1: Write inline sync module** (docstring/JSDoc updater)

```typescript
// src/sync/inline.ts
import fs from 'node:fs';

export interface InlineSyncInput {
  file: string;
  symbolName: string;
  oldSignature: string;
  newSignature: string;
  oldDocstring: string;
  newDocstring: string;
}

export function updateInlineDoc(input: InlineSyncInput): boolean {
  if (!fs.existsSync(input.file)) return false;

  let content = fs.readFileSync(input.file, 'utf-8');

  // Find the symbol definition and its associated docstring/comment
  // Replace the old signature/docstring with new
  if (input.oldSignature && input.newSignature) {
    content = content.replace(input.oldSignature, input.newSignature);
  }

  if (input.oldDocstring && input.newDocstring) {
    content = content.replace(input.oldDocstring, input.newDocstring);
  }

  fs.writeFileSync(input.file, content, 'utf-8');
  return true;
}

export function extractDocstring(file: string, symbolName: string): string | null {
  if (!fs.existsSync(file)) return null;

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const symbolLine = lines.findIndex((l) =>
    l.includes(`function ${symbolName}`) ||
    l.includes(`class ${symbolName}`) ||
    l.includes(`const ${symbolName}`) ||
    l.includes(`${symbolName}(`),
  );

  if (symbolLine < 0) return null;

  // Walk backwards to find the preceding comment block (JSDoc or multi-line)
  const commentLines: string[] = [];
  for (let i = symbolLine - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
      commentLines.unshift(lines[i]);
    } else if (commentLines.length > 0) {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines.join('\n') : null;
}

export function generateUpdatedDocstring(
  symbolName: string,
  kind: string,
  oldSignature: string,
  newSignature: string,
): string {
  // Generate a basic updated JSDoc/docstring based on the new signature
  const params = extractParams(newSignature);
  const lines = ['/**'];
  lines.push(` * ${symbolName} — [auto-updated by DocRel]`);
  for (const param of params) {
    lines.push(` * @param ${param.name} — ${param.type}`);
  }
  if (newSignature.includes('):') || kind === 'function') {
    const returnMatch = newSignature.match(/\):\s*(\S+)/);
    if (returnMatch) {
      lines.push(` * @returns {${returnMatch[1]}}`);
    }
  }
  lines.push(' */');
  return lines.join('\n');
}

function extractParams(signature: string): Array<{ name: string; type: string }> {
  const paramMatch = signature.match(/\((.*?)\)/);
  if (!paramMatch || !paramMatch[1]) return [];

  return paramMatch[1].split(',').map((p) => {
    const parts = p.trim().split(':');
    return { name: parts[0]?.trim() ?? 'arg', type: parts[1]?.trim() ?? 'any' };
  }).filter((p) => p.name.length > 0);
}
```

- [ ] **Step 2: Write standalone sync module** (markdown updater)

```typescript
// src/sync/standalone.ts
import fs from 'node:fs';

export interface StandaloneSyncInput {
  file: string;
  anchor: string;
  oldContent: string;
  newContent: string;
}

export function updateStandaloneDoc(input: StandaloneSyncInput): boolean {
  if (!fs.existsSync(input.file)) return false;

  let content = fs.readFileSync(input.file, 'utf-8');

  // Find the section by anchor (heading) and replace relevant content
  const headingRegex = new RegExp(
    `(#{1,6}\\s+${escapeRegex(input.anchor)}[^#]*?)(?=\n#{1,6}\\s|$)`,
    'is',
  );

  const match = content.match(headingRegex);
  if (!match) return false;

  const sectionContent = match[1];
  if (!sectionContent.includes(input.oldContent)) return false;

  const updatedSection = sectionContent.replace(input.oldContent, input.newContent);
  content = content.replace(sectionContent, updatedSection);

  fs.writeFileSync(input.file, content, 'utf-8');
  return true;
}

export function findSectionContent(file: string, anchor: string): string | null {
  if (!fs.existsSync(file)) return null;

  const content = fs.readFileSync(file, 'utf-8');
  const headingRegex = new RegExp(
    `(#{1,6}\\s+${escapeRegex(anchor)}[^#]*?)(?=\n#{1,6}\\s|$)`,
    'is',
  );

  const match = content.match(headingRegex);
  return match ? match[1] : null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 3: Write generated sync module**

```typescript
// src/sync/generated.ts
import { execSync } from 'node:child_process';
import path from 'node:path';

export interface GeneratedSyncInput {
  file: string;
  generator: string;  // e.g. "typedoc", "openapi-generator", "tsx scripts/generate-docs.ts"
  projectRoot: string;
}

export function updateGeneratedDoc(input: GeneratedSyncInput): { success: boolean; output: string } {
  try {
    const output = execSync(input.generator, {
      cwd: input.projectRoot,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: err.stderr ?? err.message };
  }
}

export function detectGenerator(file: string, projectRoot: string): string | null {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const scripts = pkg.scripts ?? {};

  if (file.endsWith('.yaml') || file.endsWith('.yml') || file.includes('openapi')) {
    return scripts['generate:api'] ?? scripts['generate:openapi'] ?? null;
  }

  if (file.includes('typedoc') || file.endsWith('.md') && scripts['docs:generate']) {
    return scripts['docs:generate'] ?? null;
  }

  return null;
}

import fs from 'node:fs';
```

- [ ] **Step 4: Write sync engine orchestrator**

```typescript
// src/sync/engine.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getSymbol } from '../db/symbols.js';
import { getDocSection, markDocStale, markDocSynced } from '../db/docs.js';
import { contentHash } from '../utils/hash.js';
import { updateInlineDoc, extractDocstring, generateUpdatedDocstring } from './inline.js';
import { updateStandaloneDoc, findSectionContent } from './standalone.js';
import { updateGeneratedDoc, detectGenerator } from './generated.js';

export interface SyncResult {
  symbolId: string;
  docsUpdated: string[];
  docsStaled: string[];
  errors: string[];
}

export async function syncSymbol(
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
  symbolId: string,
): Promise<SyncResult> {
  const result: SyncResult = { symbolId, docsUpdated: [], docsStaled: [], errors: [] };

  const symbol = getSymbol(db, symbolId);
  if (!symbol) {
    result.errors.push(`Symbol not found: ${symbolId}`);
    return result;
  }

  const mappings = getMappingsForSymbol(db, symbolId);
  if (mappings.length === 0) {
    return result; // No docs linked, nothing to sync
  }

  for (const mapping of mappings) {
    const doc = getDocSection(db, mapping.doc_id);
    if (!doc) continue;

    const strategy = config.strategies[doc.doc_type];

    try {
      switch (doc.doc_type) {
        case 'inline': {
          if (strategy === 'auto_update') {
            const oldDocstring = extractDocstring(symbol.location.split(':')[0], symbol.name) ?? '';
            const newSig = symbol.signature;
            const newDocstring = generateUpdatedDocstring(symbol.name, symbol.kind, '', newSig);

            updateInlineDoc({
              file: symbol.location.split(':')[0],
              symbolName: symbol.name,
              oldSignature: '',
              newSignature: '',
              oldDocstring,
              newDocstring,
            });
            markDocSynced(db, doc.id);
            result.docsUpdated.push(doc.file);
          } else {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }

        case 'standalone': {
          if (strategy === 'auto_update') {
            const sectionContent = findSectionContent(doc.file, doc.anchor);
            if (sectionContent) {
              const newHash = contentHash(sectionContent);
              if (newHash !== doc.content_hash) {
                // Content was changed externally — but we auto-discovered it.
                // In auto_update mode, we rely on the agent having already modified the doc.
                // Just update the hash.
                db.prepare("UPDATE doc_sections SET content_hash = ?, updated_at = datetime('now') WHERE id = ?")
                  .run(newHash, doc.id);
                markDocSynced(db, doc.id);
                result.docsUpdated.push(doc.file);
              }
            }
          } else if (strategy === 'mark_stale') {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }

        case 'generated': {
          if (strategy === 'auto_update') {
            const generator = detectGenerator(doc.file, process.cwd());
            if (generator) {
              const genResult = updateGeneratedDoc({ file: doc.file, generator, projectRoot: process.cwd() });
              if (genResult.success) {
                markDocSynced(db, doc.id);
                result.docsUpdated.push(doc.file);
              } else {
                result.errors.push(`Failed to regenerate ${doc.file}: ${genResult.output}`);
              }
            }
          } else {
            markDocStale(db, doc.id);
            result.docsStaled.push(doc.file);
          }
          break;
        }

        case 'architecture': {
          markDocStale(db, doc.id);
          result.docsStaled.push(doc.file);
          break;
        }
      }
    } catch (err: any) {
      result.errors.push(`Error syncing ${doc.file}: ${err.message}`);
    }
  }

  return result;
}
```

- [ ] **Step 5: Write sync engine test**

```typescript
// tests/sync/engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
import type { DocRelConfig } from '../../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockCodegraph = {
  explore: vi.fn().mockResolvedValue({ symbols: [], files: [] }),
  impact: vi.fn().mockResolvedValue({ symbol: '', affected: [] }),
  search: vi.fn().mockResolvedValue({ items: [] }),
  connect: vi.fn().mockResolvedValue(undefined),
  isAvailable: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as CodegraphClient;

const testConfig: DocRelConfig = {
  project: 'test',
  doc_dirs: ['docs'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'mark_stale',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

describe('syncSymbol', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  const symId = symbolId('typescript', 'src/auth::login', 'function');
  const docId = docSectionId('docs/api.md', 'authentication');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42', signature: 'abc123' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'authentication', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks standalone doc as stale when strategy is mark_stale', async () => {
    const result = await syncSymbol(db, mockCodegraph, testConfig, symId);
    expect(result.docsStaled).toContain('docs/api.md');

    const doc = getDocSection(db, docId);
    expect(doc!.status).toBe('stale');
  });

  it('returns empty result when symbol has no mappings', async () => {
    const orphanId = symbolId('typescript', 'orphan::fn', 'function');
    upsertSymbol(db, { id: orphanId, name: 'fn', kind: 'function' });
    const result = await syncSymbol(db, mockCodegraph, orphanId);
    expect(result.docsUpdated).toHaveLength(0);
    expect(result.docsStaled).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/sync/`
Expected: 2 tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/sync/ tests/sync/
git commit -m "feat: add CASCADE sync engine with inline, standalone, and generated strategies"
```

---

## Phase 4: MCP Tools

### Task 10: docrel_status and docrel_check tools

**Files:**
- Create: `src/tools/status.ts`
- Create: `src/tools/check.ts`
- Create: `tests/tools/status.test.ts`
- Create: `tests/tools/check.test.ts`

**Interfaces:**
- Produces: `docrelStatus(db): StatusReport` — aggregate health stats
- Produces: `docrelCheck(db, strict?): CheckReport` — list stale docs, exit code semantics

- [ ] **Step 1: Write status tool**

```typescript
// src/tools/status.ts
import type Database from 'better-sqlite3';

export interface StatusReport {
  totalSymbols: number;
  linkedSymbols: number;
  linkedPercentage: number;
  syncedDocs: number;
  staleDocs: number;
  totalDocs: number;
  syncPercentage: number;
  pendingChanges: number;
  lastScan: string | null;
}

export function docrelStatus(db: Database.Database): StatusReport {
  const totalSymbols = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }).c;
  const linkedSymbols = (db.prepare(
    'SELECT COUNT(DISTINCT symbol_id) as c FROM mappings',
  ).get() as { c: number }).c;
  const totalDocs = (db.prepare('SELECT COUNT(*) as c FROM doc_sections').get() as { c: number }).c;
  const syncedDocs = (db.prepare(
    "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'in_sync'",
  ).get() as { c: number }).c;
  const staleDocs = (db.prepare(
    "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'stale'",
  ).get() as { c: number }).c;
  const pendingChanges = (db.prepare(
    "SELECT COUNT(*) as c FROM changelog WHERE sync_status = 'pending'",
  ).get() as { c: number }).c;

  return {
    totalSymbols,
    linkedSymbols,
    linkedPercentage: totalSymbols > 0 ? Math.round((linkedSymbols / totalSymbols) * 100) : 0,
    syncedDocs,
    staleDocs,
    totalDocs,
    syncPercentage: totalDocs > 0 ? Math.round((syncedDocs / totalDocs) * 100) : 100,
    pendingChanges,
    lastScan: null,
  };
}
```

- [ ] **Step 2: Write check tool**

```typescript
// src/tools/check.ts
import type Database from 'better-sqlite3';

export interface CheckReport {
  passed: boolean;
  staleDocs: Array<{
    id: string;
    file: string;
    anchor: string;
    doc_type: string;
    status: string;
    linkedSymbols: string[];
  }>;
  summary: string;
}

export function docrelCheck(db: Database.Database, strict = false): CheckReport {
  const staleRows = db.prepare(`
    SELECT d.id, d.file, d.anchor, d.doc_type, d.status
    FROM doc_sections d
    WHERE d.status = 'stale'
  `).all() as Array<{ id: string; file: string; anchor: string; doc_type: string; status: string }>;

  const staleDocs = staleRows.map((row) => {
    const symbols = db.prepare(
      'SELECT symbol_id FROM mappings WHERE doc_id = ?',
    ).all(row.id) as Array<{ symbol_id: string }>;

    return {
      ...row,
      linkedSymbols: symbols.map((s) => s.symbol_id),
    };
  });

  const passed = strict ? staleDocs.length === 0 : true;

  let summary: string;
  if (staleDocs.length === 0) {
    summary = 'All documentation is in sync.';
  } else {
    const files = [...new Set(staleDocs.map((d) => d.file))].join(', ');
    summary = `${staleDocs.length} doc section(s) are stale across ${staleDocs.length > 0 ? [...new Set(staleDocs.map(d => d.file))].length : 0} file(s): ${files}`;
  }

  return { passed, staleDocs, summary };
}
```

- [ ] **Step 3: Write tests**

```typescript
// tests/tools/status.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, markDocStale } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { docrelStatus } from '../../src/tools/status.js';
import { docrelCheck } from '../../src/tools/check.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('docrelStatus', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports zeroes for empty database', () => {
    const status = docrelStatus(db);
    expect(status.totalSymbols).toBe(0);
    expect(status.linkedPercentage).toBe(0);
    expect(status.syncPercentage).toBe(100);
  });

  it('reports correct counts with data', () => {
    const symId = symbolId('ts', 'login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');

    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const status = docrelStatus(db);
    expect(status.totalSymbols).toBe(1);
    expect(status.linkedSymbols).toBe(1);
    expect(status.linkedPercentage).toBe(100);
  });
});

describe('docrelCheck', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes when no stale docs', () => {
    const report = docrelCheck(db, true);
    expect(report.passed).toBe(true);
  });

  it('fails when there are stale docs in strict mode', () => {
    const docId = docSectionId('docs/api.md', 'auth');
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    markDocStale(db, docId);

    const report = docrelCheck(db, true);
    expect(report.passed).toBe(false);
    expect(report.staleDocs).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/tools/status.test.ts tests/tools/check.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/status.ts src/tools/check.ts tests/tools/status.test.ts tests/tools/check.test.ts
git commit -m "feat: add docrel_status and docrel_check MCP tools"
```

---

### Task 11: docrel_impact, docrel_link, and docrel_diff tools

**Files:**
- Create: `src/tools/impact.ts`
- Create: `src/tools/link.ts`
- Create: `src/tools/diff.ts`
- Create: `tests/tools/impact.test.ts`

**Interfaces:**
- Produces: `docrelImpact(db, codegraph, paths): ImpactReport`
- Produces: `docrelLink(db, params): LinkResult`
- Produces: `docrelDiff(db, symbolId): DiffReport`

- [ ] **Step 1: Write impact tool**

```typescript
// src/tools/impact.ts
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getSymbol } from '../db/symbols.js';
import { getDocSection } from '../db/docs.js';

export interface ImpactReport {
  changedFiles: string[];
  affectedSymbols: Array<{
    id: string;
    name: string;
    kind: string;
    location: string;
  }>;
  affectedDocs: Array<{
    id: string;
    file: string;
    anchor: string;
    doc_type: string;
    status: string;
    relationship: string;
  }>;
}

export async function docrelImpact(
  db: Database.Database,
  codegraph: CodegraphClient,
  changedFiles: string[],
): Promise<ImpactReport> {
  const affectedSymbols: ImpactReport['affectedSymbols'] = [];
  const affectedDocs: ImpactReport['affectedDocs'] = [];
  const seenDocIds = new Set<string>();

  for (const file of changedFiles) {
    // Find symbols in changed files
    try {
      const result = await codegraph.explore(`symbols in ${file}`, 20);

      for (const sym of result.symbols) {
        // Look up each symbol in our database
        const allSymbols = db.prepare(
          'SELECT id, name, kind, location FROM symbols WHERE location LIKE ?',
        ).all(`${file}%`) as Array<{ id: string; name: string; kind: string; location: string }>;

        for (const dbSym of allSymbols) {
          affectedSymbols.push(dbSym);

          // Find linked docs through mappings
          const mappings = getMappingsForSymbol(db, dbSym.id);
          for (const mapping of mappings) {
            if (seenDocIds.has(mapping.doc_id)) continue;
            seenDocIds.add(mapping.doc_id);

            const doc = getDocSection(db, mapping.doc_id);
            if (doc) {
              affectedDocs.push({
                id: doc.id,
                file: doc.file,
                anchor: doc.anchor,
                doc_type: doc.doc_type,
                status: doc.status,
                relationship: mapping.rel_type,
              });
            }
          }
        }
      }
    } catch {
      // codegraph may not have indexed this file yet — skip
    }
  }

  return { changedFiles, affectedSymbols, affectedDocs };
}
```

- [ ] **Step 2: Write link and diff tools**

```typescript
// src/tools/link.ts
import type Database from 'better-sqlite3';
import { createMapping, deleteMapping } from '../db/mappings.js';

export interface LinkResult {
  action: 'created' | 'deleted' | 'error';
  symbol_id: string;
  doc_id: string;
  rel_type: string;
  message: string;
}

export function docrelLink(
  db: Database.Database,
  params: {
    action: 'create' | 'delete';
    symbol_id: string;
    doc_id: string;
    rel_type: string;
  },
): LinkResult {
  try {
    if (params.action === 'create') {
      createMapping(db, {
        symbol_id: params.symbol_id,
        doc_id: params.doc_id,
        rel_type: params.rel_type as 'describes',
      });
      return { action: 'created', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping created.' };
    } else {
      deleteMapping(db, params.symbol_id, params.doc_id, params.rel_type);
      return { action: 'deleted', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: 'Mapping deleted.' };
    }
  } catch (err: any) {
    return { action: 'error', symbol_id: params.symbol_id, doc_id: params.doc_id, rel_type: params.rel_type, message: err.message };
  }
}
```

```typescript
// src/tools/diff.ts
import type Database from 'better-sqlite3';
import { getSymbol } from '../db/symbols.js';
import { getMappingsForSymbol } from '../db/mappings.js';
import { getDocSection } from '../db/docs.js';

export interface DiffReport {
  symbol: {
    id: string;
    name: string;
    currentSignature: string;
  };
  changeLog: Array<{
    timestamp: string;
    change_type: string;
    old_sig: string;
    new_sig: string;
    sync_status: string;
  }>;
  affectedDocs: Array<{
    file: string;
    anchor: string;
    status: string;
  }>;
}

export function docrelDiff(db: Database.Database, symbolId: string): DiffReport | null {
  const symbol = getSymbol(db, symbolId);
  if (!symbol) return null;

  const changelog = db.prepare(
    'SELECT * FROM changelog WHERE symbol_id = ? ORDER BY timestamp DESC LIMIT 10',
  ).all(symbolId) as Array<{
    timestamp: string; change_type: string; old_sig: string; new_sig: string; sync_status: string;
  }>;

  const mappings = getMappingsForSymbol(db, symbolId);
  const affectedDocs = mappings.map((m) => {
    const doc = getDocSection(db, m.doc_id);
    return { file: doc?.file ?? 'unknown', anchor: doc?.anchor ?? '', status: doc?.status ?? 'unknown' };
  });

  return {
    symbol: { id: symbol.id, name: symbol.name, currentSignature: symbol.signature },
    changeLog: changelog,
    affectedDocs,
  };
}
```

- [ ] **Step 3: Write test**

```typescript
// tests/tools/impact.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { docrelImpact } from '../../src/tools/impact.js';
import { docrelLink } from '../../src/tools/link.js';
import { docrelDiff } from '../../src/tools/diff.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import type { CodegraphClient } from '../../src/codegraph/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockCodegraph = {
  explore: vi.fn().mockResolvedValue({
    symbols: [{ name: 'login', kind: 'function', file: 'src/auth.ts', line: 42 }],
    files: ['src/auth.ts'],
  }),
  impact: vi.fn().mockResolvedValue({ symbol: '', affected: [] }),
  search: vi.fn().mockResolvedValue({ items: [] }),
  connect: vi.fn().mockResolvedValue(undefined),
  isAvailable: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as CodegraphClient;

describe('docrelImpact', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds affected docs when a linked symbol file changes', async () => {
    const symId = symbolId('ts', 'src/auth.ts::login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');

    upsertSymbol(db, { id: symId, name: 'login', kind: 'function', location: 'src/auth.ts:42' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', anchor: 'auth', doc_type: 'standalone' });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const impact = await docrelImpact(db, mockCodegraph, ['src/auth.ts']);
    expect(impact.affectedDocs).toHaveLength(1);
    expect(impact.affectedDocs[0].file).toBe('docs/api.md');
  });
});

describe('docrelLink', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a mapping between symbol and doc', () => {
    const symId = symbolId('ts', 'login', 'function');
    const docId = docSectionId('docs/api.md', 'auth');
    upsertSymbol(db, { id: symId, name: 'login', kind: 'function' });
    upsertDocSection(db, { id: docId, file: 'docs/api.md', doc_type: 'standalone' });

    const result = docrelLink(db, { action: 'create', symbol_id: symId, doc_id: docId, rel_type: 'describes' });
    expect(result.action).toBe('created');

    const mappings = db.prepare('SELECT * FROM mappings').all();
    expect(mappings).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/tools/`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/impact.ts src/tools/link.ts src/tools/diff.ts tests/tools/impact.test.ts
git commit -m "feat: add docrel_impact, docrel_link, and docrel_diff MCP tools"
```

---

### Task 12: MCP Server assembly (register all tools)

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Produces: MCP Server with all 6 tools registered, ready for `node dist/index.js`

- [ ] **Step 1: Write MCP server entry point**

```typescript
// src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { loadConfig } from './utils/config.js';
import { CodegraphClient } from './codegraph/client.js';
import { docrelStatus } from './tools/status.js';
import { docrelCheck } from './tools/check.js';
import { docrelImpact } from './tools/impact.js';
import { syncSymbol } from './sync/engine.js';
import { docrelLink } from './tools/link.js';
import { docrelDiff } from './tools/diff.js';

const projectRoot = process.env.DOCREL_PROJECT_ROOT ?? process.cwd();
const config = loadConfig(projectRoot);
const db = getDb(projectRoot);
const codegraph = new CodegraphClient(config.codegraph?.command);

runMigrations(db);

const server = new McpServer({
  name: 'docrel',
  version: '0.1.0',
});

// ── docrel_status ──────────────────────────────────────────────
server.tool(
  'docrel_status',
  'Get the overall health dashboard of code-documentation synchronization',
  {},
  async () => {
    const status = docrelStatus(db);
    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
    };
  },
);

// ── docrel_check ───────────────────────────────────────────────
server.tool(
  'docrel_check',
  'Check for stale documentation. Use strict=true to fail on any stale docs.',
  {
    strict: z.boolean().optional().default(false),
    file: z.string().optional().describe('Check only a specific file'),
  },
  async ({ strict, file }) => {
    const report = docrelCheck(db, strict);
    if (file) {
      const filtered = report.staleDocs.filter((d) => d.file === file);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ passed: filtered.length === 0, staleDocs: filtered, summary: `${filtered.length} stale doc(s) in ${file}` }, null, 2),
        }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  },
);

// ── docrel_impact ──────────────────────────────────────────────
server.tool(
  'docrel_impact',
  'Analyze which documentation sections are affected by code changes',
  {
    paths: z.array(z.string()).describe('List of changed file paths or a diff string'),
  },
  async ({ paths }) => {
    const impact = await docrelImpact(db, codegraph, paths);
    return {
      content: [{ type: 'text', text: JSON.stringify(impact, null, 2) }],
    };
  },
);

// ── docrel_sync ────────────────────────────────────────────────
server.tool(
  'docrel_sync',
  'Synchronize documentation for a specific symbol (CASCADE update)',
  {
    symbol_id: z.string().describe('Stable symbol ID to sync docs for'),
  },
  async ({ symbol_id }) => {
    const result = await syncSymbol(db, codegraph, config, symbol_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── docrel_link ────────────────────────────────────────────────
server.tool(
  'docrel_link',
  'Create or delete a mapping between a code symbol and a documentation section',
  {
    action: z.enum(['create', 'delete']),
    symbol_id: z.string(),
    doc_id: z.string(),
    rel_type: z.enum(['describes', 'references', 'generates', 'contracts']),
  },
  async ({ action, symbol_id, doc_id, rel_type }) => {
    const result = docrelLink(db, { action, symbol_id, doc_id, rel_type });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── docrel_diff ────────────────────────────────────────────────
server.tool(
  'docrel_diff',
  'Show the diff of changes for a symbol and its linked documentation',
  {
    symbol_id: z.string().describe('Stable symbol ID'),
  },
  async ({ symbol_id }) => {
    const diff = docrelDiff(db, symbol_id);
    if (!diff) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Symbol not found' }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(diff, null, 2) }],
    };
  },
);

// ── Start ──────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DocRel MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds, `dist/index.js` created

- [ ] **Step 3: Update package.json to include zod**

Run: `npm install zod`

- [ ] **Step 4: Verify the MCP server can be configured**

Create example `.mcp.json` snippet for end-users:

```json
{
  "mcpServers": {
    "docrel": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "DOCREL_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts package.json package-lock.json
git commit -m "feat: assemble MCP server with all 6 tools registered"
```

---

## Phase 5: CLI Fallback

### Task 13: CLI entry point (commander.js)

**Files:**
- Create: `src/cli.ts`

- [ ] **Step 1: Write CLI**

```typescript
// src/cli.ts
#!/usr/bin/env node
import { Command } from 'commander';
import { getDb } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { loadConfig } from './utils/config.js';
import { CodegraphClient } from './codegraph/client.js';
import { docrelStatus } from './tools/status.js';
import { docrelCheck } from './tools/check.js';
import { docrelImpact } from './tools/impact.js';
import { syncSymbol } from './sync/engine.js';
import { docrelLink } from './tools/link.js';
import { docrelDiff } from './tools/diff.js';

const program = new Command();
const projectRoot = process.env.DOCREL_PROJECT_ROOT ?? process.cwd();
const config = loadConfig(projectRoot);
const db = getDb(projectRoot);
const codegraph = new CodegraphClient(config.codegraph?.command);

runMigrations(db);

program
  .name('docrel')
  .description('Code-Documentation Relational Sync System')
  .version('0.1.0');

program
  .command('status')
  .description('Show health dashboard')
  .option('--format <format>', 'Output format: json or markdown', 'json')
  .action((opts) => {
    const status = docrelStatus(db);
    if (opts.format === 'markdown') {
      console.log(`## DocRel Status
- Symbols: ${status.totalSymbols}
- Linked: ${status.linkedSymbols} (${status.linkedPercentage}%)
- Docs in sync: ${status.syncedDocs}/${status.totalDocs} (${status.syncPercentage}%)
- Pending changes: ${status.pendingChanges}`);
    } else {
      console.log(JSON.stringify(status, null, 2));
    }
  });

program
  .command('check')
  .description('Check for stale documentation')
  .option('--strict', 'Exit with code 1 if any docs are stale', false)
  .option('--file <file>', 'Check only a specific file')
  .action((opts) => {
    const report = docrelCheck(db, opts.strict);
    let filtered = report.staleDocs;
    if (opts.file) {
      filtered = report.staleDocs.filter((d) => d.file === opts.file);
    }
    console.log(JSON.stringify({ ...report, staleDocs: filtered }, null, 2));
    if (opts.strict && filtered.length > 0) {
      process.exit(1);
    }
  });

program
  .command('impact')
  .description('Show documentation affected by changed files')
  .argument('<paths...>', 'Changed file paths')
  .action(async (paths: string[]) => {
    const impact = await docrelImpact(db, codegraph, paths);
    console.log(JSON.stringify(impact, null, 2));
  });

program
  .command('sync')
  .description('Sync documentation for a symbol')
  .option('--symbol <id>', 'Symbol ID to sync')
  .action(async (opts) => {
    if (opts.symbol) {
      const result = await syncSymbol(db, codegraph, config, opts.symbol);
      console.log(JSON.stringify(result, null, 2));
    }
  });

program
  .command('link')
  .description('Create or delete a symbol-doc mapping')
  .argument('<action>', 'create or delete')
  .option('--symbol <id>', 'Symbol ID')
  .option('--doc <id>', 'Document section ID')
  .option('--type <type>', 'Relationship type', 'describes')
  .action((action, opts) => {
    const result = docrelLink(db, {
      action: action as 'create' | 'delete',
      symbol_id: opts.symbol,
      doc_id: opts.doc,
      rel_type: opts.type,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('diff')
  .description('Show change history for a symbol')
  .argument('<symbol_id>', 'Symbol ID')
  .action((symbolId) => {
    const diff = docrelDiff(db, symbolId);
    if (!diff) {
      console.error('Symbol not found');
      process.exit(1);
    }
    console.log(JSON.stringify(diff, null, 2));
  });

program.parse();
```

- [ ] **Step 2: Build and verify CLI compiles**

Run: `npm run build`
Expected: `dist/cli.js` created

- [ ] **Step 3: Test CLI status command**

Run: `node dist/cli.js status`
Expected: JSON output with zero counts (no symbols in test env)

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add CLI fallback with all 6 commands mirroring MCP tools"
```

---

## Phase 6: Git Integration

### Task 14: Git hooks logic

**Files:**
- Create: `src/git/hooks.ts`
- Create: `scripts/install-hooks.sh`

- [ ] **Step 1: Write git hooks module**

```typescript
// src/git/hooks.ts
import { simpleGit } from 'simple-git';
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { docrelCheck } from '../tools/check.js';
import { docrelImpact } from '../tools/impact.js';
import { scanProject } from '../discovery/scanner.js';
import fs from 'node:fs';
import path from 'node:path';

export async function preCommitHook(
  projectRoot: string,
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
): Promise<{ allowed: boolean; message: string }> {
  const git = simpleGit(projectRoot);
  const status = await git.status();
  const staged = status.staged.concat(status.created);

  if (staged.length === 0) {
    return { allowed: true, message: 'No staged files.' };
  }

  const report = docrelCheck(db, true);

  // Check if any staged files correspond to stale docs
  const staleFiles = new Set(report.staleDocs.map((d) => d.file));
  const conflictFiles = staged.filter((f) => staleFiles.has(f));

  if (conflictFiles.length > 0) {
    return {
      allowed: false,
      message: `DocRel: ${conflictFiles.length} staged file(s) have stale documentation:\n${conflictFiles.map((f) => `  - ${f}`).join('\n')}\n\nRun 'docrel sync' to update them, or use --no-verify to skip.`,
    };
  }

  return { allowed: true, message: 'DocRel: all docs in sync.' };
}

export async function postCommitHook(
  projectRoot: string,
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
): Promise<void> {
  const git = simpleGit(projectRoot);

  // Get the diff of the last commit
  const log = await git.log({ maxCount: 1 });
  if (!log.latest) return;

  const diff = await git.diff([`${log.latest.hash}^`, log.latest.hash]);
  if (!diff) return;

  // Re-scan affected symbols and mark docs as stale where needed
  await scanProject(codegraph, db, config);
}

export async function prePushHook(
  projectRoot: string,
  db: Database.Database,
): Promise<{ allowed: boolean; message: string }> {
  const report = docrelCheck(db, true);

  if (!report.passed) {
    return {
      allowed: false,
      message: `DocRel: Cannot push — ${report.staleDocs.length} doc section(s) are stale.\n\nRun 'docrel check' for details.`,
    };
  }

  return { allowed: true, message: 'DocRel: all docs in sync.' };
}

export function installHooks(projectRoot: string): void {
  const hooksDir = path.join(projectRoot, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const postCommitPath = path.join(hooksDir, 'post-commit');
  const prePushPath = path.join(hooksDir, 'pre-push');

  const preCommitScript = `#!/bin/sh
# DocRel pre-commit hook
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocRel: Documentation is stale. Run 'docrel sync' or use --no-verify to skip."
  exit 1
fi
`;

  const postCommitScript = `#!/bin/sh
# DocRel post-commit hook
docrel impact $(git diff --name-only HEAD~1..HEAD 2>/dev/null || echo "")
`;

  const prePushScript = `#!/bin/sh
# DocRel pre-push hook
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocRel: Cannot push with stale documentation."
  exit 1
fi
`;

  fs.writeFileSync(preCommitPath, preCommitScript, { mode: 0o755 });
  fs.writeFileSync(postCommitPath, postCommitScript, { mode: 0o755 });
  fs.writeFileSync(prePushPath, prePushScript, { mode: 0o755 });

  console.log('DocRel hooks installed in .git/hooks/');
}
```

- [ ] **Step 2: Create install script**

```bash
#!/bin/bash
# scripts/install-hooks.sh
set -e

PROJECT_ROOT="${1:-$(pwd)}"

cat > "$PROJECT_ROOT/.git/hooks/pre-commit" << 'EOF'
#!/bin/sh
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "⛔ DocRel: Documentation is stale. Run 'docrel sync' or use --no-verify to skip."
  exit 1
fi
EOF

cat > "$PROJECT_ROOT/.git/hooks/post-commit" << 'EOF'
#!/bin/sh
changed=$(git diff --name-only HEAD~1..HEAD 2>/dev/null || echo "")
if [ -n "$changed" ]; then
  docrel impact $changed
fi
EOF

cat > "$PROJECT_ROOT/.git/hooks/pre-push" << 'EOF'
#!/bin/sh
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "⛔ DocRel: Cannot push with stale documentation."
  exit 1
fi
EOF

chmod +x "$PROJECT_ROOT/.git/hooks/pre-commit"
chmod +x "$PROJECT_ROOT/.git/hooks/post-commit"
chmod +x "$PROJECT_ROOT/.git/hooks/pre-push"

echo "✅ DocRel hooks installed"
```

- [ ] **Step 3: Add install-hooks command to CLI**

Append to `src/cli.ts`:

```typescript
import { installHooks } from './git/hooks.js';

program
  .command('install-hooks')
  .description('Install DocRel git hooks in .git/hooks/')
  .action(() => {
    installHooks(projectRoot);
    console.log('DocRel hooks installed successfully.');
  });
```

- [ ] **Step 4: Commit**

```bash
git add src/git/hooks.ts scripts/install-hooks.sh src/cli.ts
git commit -m "feat: add git hook integration with pre-commit, post-commit, and pre-push hooks"
```

---

## Phase 7: Codegraph Lightweight PR

### Task 15: Codegraph PR — add doc_refs to codegraph_impact

This is a standalone task to submit a minimal PR to the Codegraph project.

**Files (in Codegraph repo):**
- Modify: `codegraph_impact` tool handler — add optional `doc_refs` field
- Modify: Symbol node schema — add optional `doc_links` property

**PR Content:**

```typescript
// In the codegraph_impact tool handler:

// NEW: Check if a .docrel/mappings.json snapshot exists and include doc references
const docrelMappingsPath = path.join(projectRoot, '.docrel', 'mappings.json');
if (fs.existsSync(docrelMappingsPath)) {
  const mappings = JSON.parse(fs.readFileSync(docrelMappingsPath, 'utf-8'));
  const affectedSymbolNames = result.affected.map((a) => a.name);

  const docRefs = mappings
    .filter((m: any) => affectedSymbolNames.includes(m.symbol_name))
    .map((m: any) => ({
      doc_file: m.doc_file,
      doc_anchor: m.doc_anchor,
      relationship: m.rel_type,
      symbol_name: m.symbol_name,
    }));

  if (docRefs.length > 0) {
    result.doc_refs = docRefs;
  }
}
```

- [ ] **Step 1: Fork/clone the Codegraph repository**
- [ ] **Step 2: Create branch `feat/doc-refs-in-impact`**
- [ ] **Step 3: Add the `doc_refs` field to the `codegraph_impact` response type**
- [ ] **Step 4: Implement the .docrel/mappings.json lookup in the impact tool**
- [ ] **Step 5: Add tests**
- [ ] **Step 6: Submit PR with description explaining the DocRel use case**
- [ ] **Step 7: Commit (in the Codegraph repo)**

---

## Phase 8: Integration & Polish

### Task 16: End-to-end integration test

**Files:**
- Create: `tests/integration/e2e.test.ts`
- Create: `fixtures/sample-project/src/auth.ts`
- Create: `fixtures/sample-project/docs/api.md`
- Create: `fixtures/expected/api-synced.md`

- [ ] **Step 1: Create sample project fixtures**

```typescript
// fixtures/sample-project/src/auth.ts
/**
 * Authenticates a user with username and password.
 * @param username — the user's login name
 * @param password — the user's secret
 * @returns an auth token
 */
export function login(username: string, password: string): string {
  return `token-${username}`;
}
```

```markdown
<!-- fixtures/sample-project/docs/api.md -->
# API Documentation

## Authentication

The `login` function takes a `username` and `password` and returns an auth token.

### login(username, password)

Authenticates a user. Returns a token string.
```

- [ ] **Step 2: Write E2E test**

```typescript
// tests/integration/e2e.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { loadConfig } from '../../src/utils/config.js';
import { docrelStatus } from '../../src/tools/status.js';
import { docrelCheck } from '../../src/tools/check.js';
import { docrelLink } from '../../src/tools/link.js';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DocRel E2E', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrel-e2e-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.docrel'), { recursive: true });

    // Copy fixtures
    fs.cpSync(
      path.join(process.cwd(), 'fixtures', 'sample-project'),
      tmpDir,
      { recursive: true },
    );

    db = getDb(tmpDir);
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full workflow: scan → link → check → detect change → mark stale', () => {
    // 1. Manually register a symbol (simulating auto-discovery)
    const symId = symbolId('typescript', 'src/auth.ts::login', 'function');
    upsertSymbol(db, {
      id: symId,
      name: 'login',
      kind: 'function',
      project: 'src',
      location: 'src/auth.ts:9',
      signature: 'abc123',
    });

    // 2. Register a doc section
    const docId = docSectionId('docs/api.md', 'Authentication');
    upsertDocSection(db, {
      id: docId,
      file: 'docs/api.md',
      anchor: 'Authentication',
      doc_type: 'standalone',
      content_hash: 'def456',
    });

    // 3. Link them
    const result = docrelLink(db, {
      action: 'create',
      symbol_id: symId,
      doc_id: docId,
      rel_type: 'describes',
    });
    expect(result.action).toBe('created');

    // 4. Status shows linked
    const status = docrelStatus(db);
    expect(status.linkedSymbols).toBe(1);
    expect(status.linkedPercentage).toBe(100);

    // 5. Check passes (doc is in_sync)
    const checkBefore = docrelCheck(db, true);
    expect(checkBefore.passed).toBe(true);

    // 6. Simulate code change — mark doc stale
    db.prepare("UPDATE doc_sections SET status = 'stale' WHERE id = ?").run(docId);

    // 7. Check fails in strict mode
    const checkAfter = docrelCheck(db, true);
    expect(checkAfter.passed).toBe(false);
    expect(checkAfter.staleDocs).toHaveLength(1);
    expect(checkAfter.staleDocs[0].file).toBe('docs/api.md');
  });
});
```

- [ ] **Step 3: Run E2E test**

Run: `npx vitest run tests/integration/`
Expected: 1 test PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/integration/ fixtures/
git commit -m "test: add end-to-end integration test with fixture project"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 0 | Task 0 | Project scaffolding (package.json, tsconfig, vitest) |
| 1 | Tasks 1-6 | Core data layer (connection, schema, CRUD, hash, config) |
| 2 | Tasks 7-8 | Codegraph integration (client, auto-discovery scanner) |
| 3 | Task 9 | Sync engine (CASCADE orchestrator, inline/standalone/generated) |
| 4 | Tasks 10-12 | MCP tools (6 tools + server assembly) |
| 5 | Task 13 | CLI fallback (commander.js) |
| 6 | Task 14 | Git integration (hooks + install script) |
| 7 | Task 15 | Codegraph PR (doc_refs field) |
| 8 | Task 16 | E2E integration test |

**Total:** 17 tasks across 8 phases.
