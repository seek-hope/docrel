# DocSync Upgrade Plan

## Current State (v0.2.3)
- 42 TypeScript source files, ~10,100 lines
- 15 test files, 186 tests
- MCP server (12 tools) + CLI (19 commands)
- Git hooks (pre-commit, post-commit, pre-push, prepare-commit-msg)
- 4 doc parsers (Markdown, RST, AsciiDoc, HTML)
- 2 symbol extractors (Codegraph, builtin regex)
- Agent auto-detection (Claude Code, Codex, OpenCode, Oh My Pi, Hermes)
- 4 doc types (inline, standalone, generated, architecture)
- SQLite with WAL mode, foreign keys, atomic UPSERT
- DA-TODO: upgrade plan — v0.2.0→v0.2.3 COMPLETE, v0.3.2+partial, v0.4.2 partial
- 40 structured error codes, 8-point health check, incremental scanning
- Watch daemon mode with PID file, CI/CD GitHub Actions workflow

---

## v0.2.0 — Polish & Robustness ✅ COMPLETE

### ✅ 0.2.0 — Error Codes & Observability
- [x] **Structured error codes**: `DOCSYNC_E001`–`DOCSYNC_E091` in `src/utils/error-codes.ts`
- [x] **Health check endpoint**: `docsync health` CLI + `docsync_health` MCP (8 checks)
- [x] **Structured logging**: `logError()` with grep-able `[DOCSYNC_E*]` prefix

### ✅ 0.2.1 — Config & Validation
- [x] **Config schema versioning**: `version: 1` in config.yaml, future-version warning
- [x] **Config validation**: `docsync config validate` + pre-flight check before scan
- [x] **Dry-run mode**: `docsync scan --dry-run` previews without DB writes

### ✅ 0.2.2 — Performance
- [x] **Incremental scanning**: `--incremental` flag skips files with mtime <= last_scan_at
- [ ] Lazy symbol extraction (deferred)
- [ ] Batch INSERT (deferred)
- [ ] Cache warming (deferred)
- [ ] Query optimization (deferred)

### ✅ 0.2.3 — Watch Mode Improvements
- [x] **Daemon mode**: `docsync watch --daemon` writes PID file
- [x] **Directory-level coalescing**: debounce keyed by watch-path group
- [x] **Watch status API**: `docsync_watch_status` MCP tool
- [x] **Auto-recovery**: `watch-failed` marker on scan errors

---

## v0.3.0 — Scale & Extensibility (in progress)

### 0.3.0 — Multi-Project Support (deferred)
- [ ] Workspace mode
- [ ] Cross-project references
- [ ] Project grouping

### 0.3.1 — Plugin System (deferred)
- [ ] Custom doc parsers
- [ ] Custom extractors
- [ ] Custom generators

### ✅ 0.3.2 — CI/CD Integration (partial)
- [x] **GitHub Actions workflow**: `.github/workflows/docsync.yml`
- [ ] GitLab CI template (deferred)
- [ ] Status badges (deferred)

### ✅ 0.3.3 — Database Improvements (partial)
- [x] **Backup/restore**: `docsync backup` and `docsync restore` commands
- [ ] LibSQL backend (deferred)

---

## v0.4.0 — Intelligence (deferred — requires LLM API)

### 0.4.0 — AI-Assisted Documentation (deferred)
### 0.4.1 — Semantic Understanding (deferred)

### ✅ 0.4.2 — Review Workflow (partial)
- [x] **Batch operations**: `docsync confirm --all`, `docsync reject --all`, `docsync reject --pattern`
- [ ] Review queue (deferred)
- [ ] Review history (deferred)

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
- **JavaScript SDK**: `@seek-hope/docsync-client` npm package
- **Python SDK**: `docsync-client` pip package
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
- `docsync upgrade` command to validate config compatibility
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
