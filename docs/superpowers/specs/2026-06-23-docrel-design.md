# DocRel — Code-Documentation Relational Sync System

> **Status:** Design Specification
> **Date:** 2026-06-23
> **Type:** New Open Source Project

## 1. Problem Statement

Documentation drift is a universal software engineering problem: as code evolves, documentation stagnates. Existing solutions (JSDoc, TypeDoc, OpenAPI generators) only cover one direction (code → docs) and only for generated docs. There is no mechanism that ensures **bidirectional referential integrity** between code symbols and all forms of documentation.

## 2. Core Concept

Treat the relationship between code and documentation like a **relational database**:

| Database Concept | DocRel Equivalent |
|-----------------|-------------------|
| Primary Key | Stable Symbol Identifier (fully qualified name + kind hash) |
| Foreign Key | Code Symbol ↔ Document Section mapping |
| ON UPDATE CASCADE | Code change → auto-update linked docs |
| CHECK constraint | pre-commit/pre-push validation: docs must be in sync |
| WAL (Write-Ahead Log) | Change log tracking all symbol mutations |
| JOIN table | `mappings` table linking symbols to doc sections |

## 3. Architecture (Layers)

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: Agent Adapter                   │
│  Claude Code (MCP)  │  OpenCode (MCP)  │  Oh My Pi (CLI)   │
├─────────────────────────────────────────────────────────────┤
│                    Layer 2: DocRel Core (MCP Server)        │
│  Impact Analyzer  │  Sync Engine  │  File Watcher          │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: Data & Spec                     │
│  .git/docrel.db (SQLite)  │  .docrel/ config directory     │
│  docrel-spec (open standard)                               │
├─────────────────────────────────────────────────────────────┤
│              Codegraph (symbol intelligence backend)        │
│  codegraph_explore  │  codegraph_impact  │  codegraph_search│
└─────────────────────────────────────────────────────────────┘
```

## 4. Data Model

### 4.1 Tables

**symbols** — Code symbol registry
| Column     | Type    | Description |
|------------|---------|-------------|
| id         | TEXT PK | Stable identifier: `hash(FQN + kind)` |
| name       | TEXT    | Human-readable name |
| kind       | TEXT    | function, class, module, api_endpoint, type, interface |
| project    | TEXT    | Package/module namespace |
| location   | TEXT    | Current file:line (tracked by codegraph) |
| signature  | TEXT    | Signature hash for change detection |
| metadata   | JSON    | Extra context (language, exports, etc.) |

**doc_sections** — Documentation paragraph registry
| Column       | Type    | Description |
|-------------|---------|-------------|
| id          | TEXT PK | Stable identifier: `hash(file + anchor)` |
| file        | TEXT    | Documentation file path |
| anchor      | TEXT    | Section heading or anchor within the file |
| content_hash| TEXT    | Current content hash |
| doc_type    | TEXT    | inline, standalone, generated, architecture |
| status      | TEXT    | in_sync, stale, draft |

**mappings** — JOIN table (the "foreign keys")
| Column     | Type    | Description |
|------------|---------|-------------|
| symbol_id  | TEXT FK | → symbols(id) |
| doc_id     | TEXT FK | → doc_sections(id) |
| rel_type   | TEXT    | describes, references, generates, contracts |
| confidence | REAL    | 0.0–1.0 (auto-inference confidence) |
| PRIMARY KEY (symbol_id, doc_id, rel_type) |

**changelog** — WAL-style change tracker
| Column       | Type      | Description |
|-------------|-----------|-------------|
| id          | INTEGER PK| Auto-increment |
| timestamp   | DATETIME  | When the change was detected |
| symbol_id   | TEXT      | Affected symbol |
| change_type | TEXT      | signature_changed, moved, renamed, deleted |
| old_sig     | TEXT      | Pre-change signature hash |
| new_sig     | TEXT      | Post-change signature hash |
| affected_docs| TEXT     | JSON array of doc IDs |
| sync_status | TEXT      | pending, applied, failed |

### 4.2 Stable Identity Design

Symbol IDs are computed as: `SHA256("{language}:{fully_qualified_name}:{kind}")`

- **Not file-based**: Codegraph tracks the symbol as it moves between files
- **Survives renames**: Codegraph resolves the new name to the same identity
- **Cross-language**: Language prefix prevents collisions

## 5. MCP Server — Tool Interfaces

### 5.1 Tools

| Tool | Input | Output | Description |
|------|-------|--------|-------------|
| `docrel_impact` | file paths or diff | affected doc_sections list | Uses codegraph_impact → JOIN mappings |
| `docrel_sync` | symbol_id or doc_id | diff of proposed doc changes | Executes CASCADE logic per doc_type |
| `docrel_check` | file path (optional) | list of stale docs + integrity report | Compares stored vs current signature hashes |
| `docrel_link` | symbol_id, doc_id, rel_type | success/fail | Create or update a mapping |
| `docrel_status` | — | health dashboard | Aggregate stats: total symbols, linked %, sync % |
| `docrel_diff` | symbol_id or changelog_id | before/after comparison | old/new signature + old/new doc content |

### 5.2 CASCADE Strategy by Document Type

| doc_type | Trigger | Agent Behavior |
|----------|---------|----------------|
| inline (docstring, JSDoc) | signature hash changed | Directly rewrite inline docs in source |
| standalone (markdown) | linked symbol changed | Generate doc diff, present for Agent review |
| generated (OpenAPI, TypeDoc) | source symbol changed | Re-run generator command |
| architecture (ADR) | linked module changed | Mark stale, generate "suggested review" notice |

### 5.3 CLI Fallback

Every MCP tool has a CLI equivalent for agents without MCP support:

```bash
docrel impact src/auth/login.ts           # JSON output
docrel sync --symbol auth/login           # Generate doc diff
docrel check --strict                     # Exit code 0/1 (CI-friendly)
docrel status --format markdown           # Agent-readable format
```

## 6. Git Integration (Plan B)

| Git Event | DocRel Action |
|-----------|---------------|
| pre-commit | `docrel_check --quick`: staged files' linked docs must not be stale |
| post-commit | `docrel_impact HEAD~1..HEAD`: mark affected docs stale |
| pre-push | `docrel_check --strict`: all stale docs must be resolved |
| post-merge | Re-index codegraph → update symbols table |

Commit messages are automatically annotated:
```
DocRel: 8 symbols changed, 3 docs synced, 1 doc flagged for review
```

## 7. Project Directory Convention (`.docrel/`)

```
project/
├── .docrel/
│   ├── config.yaml         # project name, doc directories, strategy
│   ├── mappings.json       # human-readable mapping snapshot (optional)
│   └── generated/          # auto-generated intermediates
│       ├── symbols.json    # codegraph symbol export
│       └── docs.json       # parsed doc section index
├── .git/
│   └── docrel.db           # SQLite database (Plan B storage)
└── src/...
```

## 8. Codegraph Integration (Lightweight PR)

A minimal PR to Codegraph adding:

1. **`codegraph_impact` enhancement**: Return optional `doc_refs` field listing documentation files known to reference affected symbols
2. **Symbol node property**: `doc_links` — array of known doc section references on a symbol node

These are read-only hints; Codegraph does not manage the mappings. That responsibility stays in DocRel.

## 9. End-to-End Workflow

```
User: "Refactor auth module from JWT to session-based"

1. AGENT SCOPES THE CHANGE
   docrel_impact(paths=["src/auth/"])
   → Returns: 8 symbols affected, 3 docs linked
     - src/auth/login.ts
     - src/auth/middleware.ts
     - docs/api/auth.md (standalone)
     - docs/architecture/security.md (architecture)
     - openapi.yaml (generated)

2. AGENT REFACTORS CODE
   → Modifies 8 symbols
   → codegraph re-indexes on each change

3. AGENT CASCADES TO DOCS
   docrel_sync("auth/login")
   ├─ Inline docstring in login.ts ✅ updated
   ├─ docs/api/auth.md section rewritten → Agent reviews → ✅ applied
   └─ openapi.yaml ✅ regenerated

   docrel_sync("auth/middleware")
   └─ docs/architecture/security.md → marked stale + review suggestion

4. PRE-COMMIT HOOK
   docrel_check → security.md still stale
   → User decides: update now / skip (--no-verify) / record as tech debt

5. COMMIT
   → Auto-annotated with DocRel summary
```

## 10. Agent Session Startup

```
Agent starts → docrel_status()
├─ 92%+ sync → Normal operation
├─ Stale docs found → "5 docs may be outdated. Update now?"
└─ First run (empty DB) → Scan codegraph index + parse docs
                          → Auto-initialize mappings
                          → "Found 287 symbols, linked 245 docs"
```

## 11. Non-Goals (for v1)

- Real-time collaborative editing (multiple agents)
- Branch-aware doc merging strategies
- Non-codegraph backends (designed to be replaceable, but not in v1)
- Web dashboard
- IDE plugin (LSP extension deferred to v2)

## 12. Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| MCP Server | TypeScript (mcp-sdk) | Best ecosystem support, Claude Code native |
| CLI | TypeScript (compiled to binary) | Same codebase as MCP server |
| Database | SQLite (better-sqlite3) | Zero-config, file-based, follows repo |
| Codegraph backend | MCP (codegraph MCP server) | Already available in this session |
| File watching | chokidar | Cross-platform, mature |
| Git hooks | husky / direct .git/hooks installation | Standard approach |

## 13. Version 1 Scope

1. MCP Server with 6 tools (docrel_impact, docrel_sync, docrel_check, docrel_link, docrel_status, docrel_diff)
2. SQLite data layer with all 4 tables
3. Codegraph MCP integration as primary symbol backend
4. Auto-discovery: scan codegraph index + parse doc references
5. CASCADE sync for inline and standalone doc types
6. Git hook integration (pre-commit, post-commit, pre-push)
7. CLI fallback for all MCP tools
8. `.docrel/` directory convention + config
9. Codegraph lightweight PR (doc_refs field)
