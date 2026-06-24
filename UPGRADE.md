# DocRel Upgrade Plan

## Current State (v0.1.0)
- 38 TypeScript source files, ~9,300 lines
- 15 test files, 186 tests
- MCP server (10 tools) + CLI (16 commands)
- Git hooks (pre-commit, post-commit, pre-push, prepare-commit-msg)
- 4 doc parsers (Markdown, RST, AsciiDoc, HTML)
- 2 symbol extractors (Codegraph, builtin regex)
- Agent auto-detection (Claude Code, Codex, OpenCode, Oh My Pi, Hermes)
- 4 doc types (inline, standalone, generated, architecture)
- SQLite with WAL mode, foreign keys, atomic UPSERT

---

## v0.2.0 — Polish & Robustness (4 weeks)

### 0.2.0 — Error Codes & Observability
- **Structured error codes**: Replace ad-hoc `console.error` with `DOCREL_E001`–`DOCREL_E099` codes
  - E001: Database connection failed
  - E002: SQLITE_BUSY — concurrent access conflict
  - E003: Codegraph unavailable — falling back to builtin
  - E004: Generator command rejected — security validation
  - E005: File read error — permission/IO
  - E006: Path traversal blocked
  - E007: Sync partial failure — some docs updated, some skipped
- **Health check endpoint**: `docrel health` command for CI/monitoring
- **Metrics collection**: scan duration, symbol count, mapping count over time
- **Structured logging**: JSON log format option for log aggregation

### 0.2.1 — Config & Validation
- **Config schema versioning**: `version: 1` in config.yaml for future migrations
- **Config validation at startup**: Fail-fast on invalid config with actionable messages
- **Environment validation**: Verify codegraph binary, npm availability, file permissions
- **Dry-run mode**: `docrel scan --dry-run` to preview without DB writes
- **Config profiles**: `docrel --profile production` for environment-specific settings

### 0.2.2 — Performance
- **Incremental scanning**: Only re-scan files with mtime > last scan time
- **Lazy symbol extraction**: Defer signature extraction until sync is needed
- **Batch INSERT**: Use `db.prepare().run()` in transactions for bulk symbol import
- **Cache warming**: Pre-load frequently-accessed data on startup
- **Query optimization**: Add composite indexes for common query patterns

### 0.2.3 — Watch Mode Improvements
- **Persistent watch daemon**: `docrel watch --daemon` with PID file
- **Watch event coalescing**: Group rapid changes by directory
- **Watch status API**: MCP tool to check watch health
- **Auto-recovery**: Restart watcher on crash, re-scan on missed events

---

## v0.3.0 — Scale & Extensibility (8 weeks)

### 0.3.0 — Multi-Project Support
- **Workspace mode**: `docrel.workspace.yaml` for monorepos
- **Cross-project references**: Track doc→code references across project boundaries
- **Project grouping**: `docrel status --workspace` for aggregate health

### 0.3.1 — Plugin System
- **Custom doc parsers**: Register parsers via `docrel.parsers` in config
- **Custom extractors**: Plug in language-specific symbol extractors
- **Custom generators**: Register documentation generators with validation rules
- **Hook plugins**: Pre/post-scan hooks for custom workflows

### 0.3.2 — CI/CD Integration
- **GitHub Actions**: First-class action with PR annotations
- **GitLab CI template**: `.docrel-ci.yml` include
- **Jenkins/GitHub webhook**: `docrel server --webhook` mode
- **Status badges**: Generate shields.io-compatible JSON endpoints
- **PR diff integration**: Compare doc health between branches

### 0.3.3 — Database Improvements
- **SQLite → LibSQL**: Optional turso/libsql backend for remote replicas
- **Read replicas**: Multi-reader support for MCP server scaling
- **Backup/restore**: `docrel backup` and `docrel restore` commands
- **Migration safety**: Downgrade detection, backup-before-migrate

---

## v0.4.0 — Intelligence (8 weeks)

### 0.4.0 — AI-Assisted Documentation
- **LLM-based doc generation**: Generate docstring drafts from signatures
- **Doc quality scoring**: Rate documentation completeness per symbol
- **Gap analysis**: Identify symbols with no docs, docs with no examples
- **Auto-suggest**: Propose mappings with confidence explanations

### 0.4.1 — Semantic Understanding
- **Embedding-based matching**: Vector similarity for symbol↔doc pairing
- **Cross-language linking**: Match Python docs to Rust implementations
- **Doc clustering**: Group related documentation sections
- **Breaking change detection**: Flag signature changes that break documented APIs

### 0.4.2 — Review Workflow
- **Review queue**: Prioritized list of unreviewed mappings
- **Batch operations**: `docrel confirm --all`, `docrel reject --pattern`
- **Review history**: Track who/when/why for each confirmation/rejection
- **Review SLAs**: Alert on mappings unreviewed for >N days

---

## v1.0.0 — Platform (12 weeks)

### 1.0.0 — Web Dashboard
- **Real-time health view**: Symbol/doc counts, sync status, trends
- **Interactive graph**: D3/vis.js graph of symbol↔doc relationships
- **Search**: Full-text search across symbols, docs, and mappings
- **Diff viewer**: Side-by-side old/new signature comparison
- **Dark mode**: Because developers

### 1.0.1 — Team Features
- **Multi-user review**: Assign reviews to team members
- **Review comments**: Threaded discussion on specific mappings
- **Activity feed**: Who scanned/synced/reviewed what
- **RBAC**: Admin/editor/viewer roles

### 1.0.2 — API & SDK
- **REST API**: HTTP endpoints for all MCP tools
- **JavaScript SDK**: `@seek-hope/docrel-client` npm package
- **Python SDK**: `docrel-client` pip package
- **WebSocket events**: Real-time scan/sync/review notifications

### 1.0.3 — Enterprise
- **SSO/OIDC**: Authenticate via corporate identity providers
- **Audit logging**: Immutable log of all operations
- **Compliance reports**: Documentation coverage for SOC2/ISO27001
- **On-prem deployment**: Docker image, Kubernetes helm chart

---

## Architecture Evolution

```
v0.1.0 (current)          v0.3.0 (extensible)       v1.0.0 (platform)
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  MCP Server     │       │  MCP + REST     │       │  Web Dashboard  │
│  CLI            │       │  CLI + CI/CD     │       │  REST API       │
│  SQLite (local) │       │  LibSQL (remote) │       │  PostgreSQL     │
│  4 parsers      │       │  Plugin parsers  │       │  Plugin system  │
│  2 extractors   │       │  Plugin extract. │       │  LLM integration│
│  Git hooks      │       │  CI templates    │       │  Team features  │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

---

## Migration Path

### From v0.1.0 → v0.2.0
- No breaking changes
- `docrel upgrade` command to validate config compatibility
- Database schema: v4 → v5 (add `error_codes` metadata table)

### From v0.2.0 → v0.3.0
- Workspace config is additive (single-project mode still works)
- Plugin API is opt-in
- Database: add `projects` table for multi-project support

### From v0.3.0 → v0.4.0
- LLM features require API key configuration
- All AI features are opt-in with graceful degradation
- Database: add `review_assignments` and `review_comments` tables

### From v0.4.0 → v1.0.0
- Breaking: REST API replaces direct SQLite access for multi-user
- Database migration: SQLite → PostgreSQL for dashboard
- Backward compatibility: SQLite mode retained for single-user CLI

---

## Immediate Next Steps (this week)

1. **Tag v0.1.0**: `git tag v0.1.0 && git push --tags`
2. **Publish to npm**: `npm publish` (verify package.json fields)
3. **CHANGELOG.md**: Document all features and fixes since inception
4. **CONTRIBUTING.md**: Developer setup guide, architecture overview
5. **GitHub Actions CI**: Build + test + lint on push/PR
