# DocRelay Roadmap & Upgrade Plan

> Historical note: this plan was written when the project was called **DocSync**
> (`docsync`). The project has since been renamed to **DocRelay**
> (`doc-relay` / `docrelay`); early milestone entries keep the old name.

## Current State (v0.3.1, 2026-09)

- 47 TypeScript source files, ~13,400 lines (ES2023, NodeNext, pure ESM)
- 64 test files, **1036 tests**, coverage 95.3/88.4/95.0/96.2
  (stmts/branch/funcs/lines, ratcheting CI gate)
- MCP server (17 tools, in-process testable via `createDocrelayServer`)
  + CLI (27 commands, thin shim → `cli-main`)
- Git hooks (pre-commit, post-commit, pre-push, prepare-commit-msg)
- 4 doc parsers (Markdown, RST, AsciiDoc, HTML)
- 2 symbol extractors (Codegraph MCP, builtin regex fallback)
- Agent auto-detection & integration (Claude Code, Codex, OpenCode,
  Oh My Pi, Hermes, Cursor, Gemini, Kiro, Antigravity)
- 4 doc types (inline, standalone, generated, architecture)
- SQLite schema v5 (WAL, foreign keys, atomic UPSERT, review_history)
- 44 structured error codes, 8-point health check, incremental scanning
- Watch daemon mode with PID file and directory-level debounce
- npm package: 255.6 kB / 200 files, docs included, npm >= 12 ready
  (N-API prebuilds via better-sqlite3 v13 + startup binding shim)
- Release automation: tag push → gates → npm publish (provenance)
  → GitHub Release (blocked only on the NPM_TOKEN secret)

---

## v0.2.0 — Polish & Robustness ✅ COMPLETE

### ✅ 0.2.0 — Error Codes & Observability
- [x] Structured error codes (`DOCRELAY_E001`–`E091` family, 44 active)
- [x] Health check endpoint (CLI + MCP, 8 checks)
- [x] Structured logging with grep-able error-code prefix

### ✅ 0.2.1 — Config & Validation
- [x] Config schema versioning with future-version warning
- [x] `config validate` + pre-flight check before scan
- [x] `scan --dry-run` preview mode

### ✅ 0.2.2 — Performance
- [x] Incremental scanning (mtime <= last_scan_at skip)
- [x] Batch INSERT in single SQLite transactions (~21% faster)
- [ ] Lazy symbol extraction (deferred)
- [ ] Cache warming / query optimization (deferred)

### ✅ 0.2.3 — Watch Mode Improvements
- [x] Daemon mode with PID file
- [x] Directory-level debounce coalescing
- [x] `docrelay_watch_status` MCP tool
- [x] Auto-recovery via `watch-failed` marker

---

## v0.3.0 — Scale & Extensibility ✅ COMPLETE (0.3.2/0.3.3 shipped; 0.3.0/0.3.1 deferred by design)

### 0.3.0 — Multi-Project Support (deferred)
- [ ] Workspace mode / cross-project references / project grouping
- Design notes: additive config (`projects: [...]`), new `projects` table,
  single-project mode stays the default. Start after v0.4 scope is set —
  see "Deferred design explorations" below.

### 0.3.1 — Plugin System (deferred)
- [ ] Custom doc parsers / extractors / generators
- Design notes: opt-in API surface must come *after* the v1.0 REST split
  to avoid freezing a plugin ABI we would immediately break.

### ✅ 0.3.2 — CI/CD Integration
- [x] GitHub Actions workflow + GitLab CI template + CI/CD guide
- [x] Status badges (`check --format shields`)

### ✅ 0.3.3 — Database Improvements
- [x] `backup` / `restore` commands with `--keep` rotation
- [ ] LibSQL backend (deferred — see below)

### Tooling & release engineering (beyond the original 0.3 plan)
- [x] commander 15 / eslint 10 / better-sqlite3 13 / chokidar 5
- [x] npm >= 12 compatibility (allowScripts, binding smoke tests, CLI shim)
- [x] Release workflow with npm provenance + GitHub Release assets

---

## v0.4.0 — Intelligence (deferred — requires LLM API)

### 0.4.0 — AI-Assisted Documentation (deferred)
### 0.4.1 — Semantic Understanding (deferred)

### ✅ 0.4.2 — Review Workflow (partial)
- [x] Batch operations: `confirm --all`, `reject --all`, `reject --pattern`
- [ ] Review queue (deferred)
- [x] Review history: append-only audit trail with CLI/MCP actor attribution

---

## Deferred design explorations (v0.4+ candidates)

- **Multi-project workspace** — highest user demand candidate. Open
  questions: one DB per project vs. shared DB with `project_id`; how
  cross-project mappings interact with path containment checks.
- **LibSQL backend** — enables team-shared state without PostgreSQL.
  Blocked on deciding the remote-sync story (embedded replica vs.
  server); better-sqlite3 remains the default either way.
- **TypeScript 7 (tsgo) migration** — build/typecheck speedup. Blocked
  on typescript-eslint peer support (`<6.1.0` as of 8.71). Re-evaluate
  when typescript-eslint 9 ships with TS 7 support; `@types/node` stays
  pinned to the supported runtime floor (Node 22).
- **LLM features (0.4.0/0.4.1)** — all opt-in, graceful degradation
  without an API key; no network calls in the default configuration.
- **Auto-link inverted token index** — the remaining scan hotspot after
  the 0.3.1 perf campaign (pair-eval ~48% of full scan: fuzzyNorm LCS,
  scoreProfile, fastScoreProfile). Sketch: pass-2 symbols provably have
  no heading-word/backtick matches (pass 1 linked those), so a superset
  filter can skip hopeless pairs: 4-gram index on
  nameNorm × (headingNorm + refNorms), plus watertight buckets for
  short names (<4 grams), short heading/refNorms, exact-name, fileStem,
  and names containing non-word chars. Every bucket must be watertight
  or links silently vanish — verify via the differential-corpora
  methodology used for the 0.3.1 scan/sync refactors (byte-identical
  symbols/doc_sections/mappings dumps old vs new).

---

## v1.0.0 — Platform (12 weeks)

### 1.0.0 — Web Dashboard
- Real-time health view: symbol/doc counts, sync status, trends
- Interactive graph of symbol↔doc relationships
- Full-text search across symbols, docs, mappings
- Side-by-side signature diff viewer

### 1.0.1 — Team Features
- Multi-user review assignment, threaded comments, activity feed, RBAC

### 1.0.2 — API & SDK
- REST API for all MCP tools; JS/Python SDKs; WebSocket events

### 1.0.3 — Enterprise
- SSO/OIDC, immutable audit logging, compliance reports, on-prem images

---

## Architecture Evolution

```
v0.3.1 (current)          v0.4.0 (intelligence)     v1.0.0 (platform)
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  MCP Server     │       │  MCP + LLM      │       │  Web Dashboard  │
│  CLI (27 cmds)  │       │  CLI + CI/CD    │       │  REST API       │
│  SQLite (local) │       │  SQLite/LibSQL  │       │  PostgreSQL     │
│  4 parsers      │       │  Semantic layer │       │  Plugin system  │
│  2 extractors   │       │  Review queue   │       │  Team features  │
│  Git hooks      │       │  CI templates   │       │  Enterprise     │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

---

## Migration Path

### From v0.2.x → v0.3.x
- No breaking changes; config is additive
- Database: schema v4 → v5 (adds `review_history`; auto-migrated on open)

### From v0.3.x → v0.4.0
- LLM features require API key configuration (opt-in)
- Database: add `review_assignments` and `review_comments` tables

### From v0.4.0 → v1.0.0
- Breaking: REST API replaces direct SQLite access for multi-user
- Database migration: SQLite → PostgreSQL for the dashboard
- Backward compatibility: SQLite mode retained for single-user CLI

---

## Immediate Next Steps

1. **Publish v0.3.1 to npm** — add the `NPM_TOKEN` repo secret, then
   `git tag v0.3.1 && git push --tags` (release workflow runs all gates,
   publishes with provenance, and creates the GitHub Release).
2. **Pick the v0.4 headline feature** — recommend exactly one of:
   multi-project workspace (user-facing breadth) or LLM-assisted docs
   (differentiation). Decide before opening 0.4.0 issues.
3. **Track typescript-eslint 9** for the TS 7 (tsgo) migration window.
