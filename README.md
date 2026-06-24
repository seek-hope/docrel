# DocRelay — Code-Documentation Relational Sync

[**中文**](README.zh-CN.md)

[![Tests](https://img.shields.io/badge/tests-50%20passed-brightgreen)](https://github.com/seek-hope/docrel/actions)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Treat documentation like a database.** DocRelay applies relational database concepts — foreign keys, CASCADE updates, CHECK constraints — to keep code and documentation in sync automatically. No manual annotations required.

When you refactor code, DocRelay tells your AI agent (or you) exactly which documentation sections need updating, and can even apply the changes automatically.

## How It Works

```
┌──────────┐     ┌──────────────┐     ┌──────────┐
│  Code    │────▶│   DocRelay     │────▶│   Docs   │
│ changes  │     │  .docrelay.db  │     │ updated  │
└──────────┘     └──────┬───────┘     └──────────┘
                        │
                 ┌──────▼───────┐
                 │  Codegraph   │
                 │  (symbol     │
                 │   tracking)  │
                 └──────────────┘
```

| Database Concept | DocRelay Equivalent |
|-----------------|-------------------|
| Primary Key | Stable Symbol ID — `SHA256(lang:fqn:kind)` stays constant across renames |
| Foreign Key | Symbol ↔ Doc Section mapping (JOIN table) |
| ON UPDATE CASCADE | Code change → auto-update linked docs (configurable per doc type) |
| CHECK constraint | Git hooks prevent commits with stale documentation |
| WAL Log | Full changelog tracking every symbol mutation |

DocRelay uses [Codegraph](https://github.com/colbymchenry/codegraph) to track symbols across renames and file moves — documentation links survive refactoring.

## Quick Start

### Installation

```bash
npm install -g doc-relay
```

### First Use in a Project

```bash
cd your-project

# One-step initialization (config + DB + git hooks + scan)
doc-relay init

# Check documentation health
doc-relay status
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `doc-relay init` | One-step setup: config, database, git hooks, codebase scan |
| `doc-relay status` | Health dashboard — symbol count, doc sync %, stale docs |
| `doc-relay check` | List stale documentation. `--strict` exits code 1 for CI |
| `doc-relay impact <files...>` | Show which docs are affected by changed files |
| `doc-relay sync --symbol <id>` | CASCADE-update docs linked to a symbol |
| `doc-relay link create --symbol <id> --doc <id>` | Create a manual mapping |
| `doc-relay diff <symbol_id>` | View change history for a symbol |
| `doc-relay scan` | Scan codebase via codegraph and discover all symbols |
| `doc-relay export-mappings` | Export `.docrelay/mappings.json` for CodeGraph integration |
| `doc-relay install-hooks` | Install pre-commit, post-commit, pre-push hooks |
| `doc-relay update` | Update DocRelay to the latest version via npm |

### MCP Server (AI Agent Integration)

Add to your agent's MCP configuration:

```json
{
  "mcpServers": {
    "doc-relay": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "DOCRELAY_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

DocRelay exposes 6 MCP tools mirroring the CLI: `docrelay_status`, `docrelay_check`, `docrelay_impact`, `docrelay_sync`, `docrelay_link`, `docrelay_diff`.

### Configuration (`.docrelay/config.yaml`)

```yaml
project: my-project
doc_dirs:
  - docs
  - README.md
code_dirs:
  - src
strategies:
  inline: auto_update       # Docstrings in source — rewrite directly
  standalone: auto_update   # Markdown docs — generate diff, agent reviews
  generated: auto_update    # TypeDoc/OpenAPI — re-run generator
  architecture: mark_stale  # Architecture docs — flag for review only
```

## End-to-End Example

```
User: "Rename login() to authenticate() across the project"

Agent calls: docrelay_impact(paths=["src/auth.ts"])
→ Returns:
  - 1 symbol affected: login (function)
  - 3 docs linked:
    • src/auth.ts (inline docstring) — will be auto-updated
    • docs/api.md § Authentication (standalone) — will be rewritten
    • docs/architecture/security.md (architecture) — will be marked stale

Agent refactors code → login() → authenticate()

Agent calls: docrelay_sync("auth:login")
  ├─ Inline docstring ✅ updated in src/auth.ts
  ├─ docs/api.md section ✅ rewritten with new signature
  └─ docs/architecture/security.md ⚠️ marked stale

Pre-commit hook: docrelay_check --strict
→ security.md is stale → User decides to review

Commit auto-annotated:
  DocRelay: 1 symbol changed, 2 docs synced, 1 doc flagged for review
```

### Git Hook Behavior

| Hook | Action |
|------|--------|
| **pre-commit** | `doc-relay check --quick` — blocks commit if staged files have stale docs |
| **post-commit** | `doc-relay impact` — marks affected docs as stale for next session |
| **pre-push** | `doc-relay check --strict` — blocks push with stale documentation |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: Agent Adapter                   │
│  Claude Code (MCP)  │  OpenCode (MCP)  │  Any Agent (CLI)  │
├─────────────────────────────────────────────────────────────┤
│                    Layer 2: DocRelay Core                     │
│  Impact Analyzer  │  CASCADE Engine  │  Git Hooks          │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: Data Store                      │
│  .git/docrelay.db (SQLite)  │  .docrelay/ config & mappings     │
├─────────────────────────────────────────────────────────────┤
│                    Layer 0: Symbol Backend                  │
│              Codegraph (symbol identity tracking)           │
└─────────────────────────────────────────────────────────────┘
```

### Project Structure

```
src/
├── index.ts              # MCP Server entry (6 tools, stdio transport)
├── cli.ts                # CLI entry (8 commands, commander.js)
├── db/                   # SQLite data layer
│   ├── connection.ts     # Singleton connection (WAL mode, FK enabled)
│   ├── schema.ts         # 4 tables + indexes + migrations
│   ├── symbols.ts        # CRUD for code symbols
│   ├── docs.ts           # CRUD for documentation sections
│   └── mappings.ts       # FK join table + JSON export
├── codegraph/client.ts   # Codegraph MCP stdio client
├── discovery/scanner.ts  # Auto-discover symbols from codegraph index
├── sync/                 # CASCADE sync strategies
│   ├── engine.ts         # Orchestrator — routes by doc_type
│   ├── inline.ts         # Docstring/JSDoc updater
│   ├── standalone.ts     # Markdown section rewriter
│   └── generated.ts      # Generator trigger (TypeDoc, OpenAPI)
├── tools/                # MCP tool handlers
│   ├── status.ts, check.ts, impact.ts, sync.ts, link.ts, diff.ts
├── git/hooks.ts          # pre-commit, post-commit, pre-push logic
└── utils/                # hash.ts (SHA256 IDs), config.ts (YAML parser)
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (ES2023, NodeNext, ESM) |
| MCP Server | `@modelcontextprotocol/sdk` |
| Database | SQLite via `better-sqlite3` |
| Symbol Backend | Codegraph MCP Server (`colbymchenry/codegraph`) |
| CLI | `commander` |
| Git | `simple-git` + native hooks |
| Tests | `vitest` (50 tests, 9 suites) |

## Codegraph Integration

DocRelay uses [Codegraph](https://github.com/colbymchenry/codegraph) as its symbol intelligence backend:

- **Auto-discovery**: Scans codegraph index to populate the `symbols` table
- **Change tracking**: Detects signature changes via codegraph's symbol identity
- **Impact analysis**: Uses `codegraph_analyze_impact` to find affected docs
- **`doc_refs` field**: A [lightweight PR](https://github.com/colbymchenry/codegraph/pull/6) adds `doc_refs` to CodeGraph's impact response — reads `.docrelay/mappings.json` if present

```bash
# Generate the file CodeGraph reads:
doc-relay export-mappings
# → writes .docrelay/mappings.json

# Now codegraph_analyze_impact responses include:
# "doc_refs": [{"doc_file": "docs/api.md", "symbol_name": "login", ...}]
```

## FAQ

**Do I need to annotate my code?** No. DocRelay is zero-annotation. Codegraph discovers symbols, DocRelay parses docs for code references, and mappings are built automatically.

**What languages are supported?** DocRelay itself is language-agnostic. The codegraph backend supports 37+ languages (TypeScript, Python, Rust, Go, Java, C/C++, etc.).

**What if I don't use an AI agent?** DocRelay works standalone. The CLI gives you full visibility into doc health. Git hooks enforce consistency without any agent.

**Can I customize sync behavior?** Yes. Each doc type (inline, standalone, generated, architecture) has its own strategy in `.docrelay/config.yaml` — choose between `auto_update`, `mark_stale`, `prompt`, or `ignore`.

**Is this ready for production?** DocRelay is in early development (v0.1.0). The core DB layer, MCP server, and CLI are solid. Areas still maturing: file watcher integration, performance at scale, and broader language ecosystem testing.

## Contributing

See [docs/superpowers/specs/2026-06-23-doc-relay-design.md](docs/superpowers/specs/2026-06-23-doc-relay-design.md) for the full design spec and [docs/superpowers/plans/2026-06-23-doc-relay-implementation.md](docs/superpowers/plans/2026-06-23-doc-relay-implementation.md) for the implementation plan.

```bash
git clone https://github.com/seek-hope/doc-relay.git
cd doc-relay
npm install
npm test          # 50 tests
npm run build     # → dist/
```

## License

MIT

<!-- Chinese version: see README.zh-CN.md -->
