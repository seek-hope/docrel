# DocRelay Architecture

DocRelay applies relational-database concepts to code↔documentation
synchronization. This document explains the model and the major components.

## The relational model

| Database concept | DocRelay equivalent |
|------------------|---------------------|
| Primary key | Stable symbol ID — `SHA256(lang:fqn:kind)`, invariant across renames and moves |
| Foreign key | `mappings` join table linking symbols to doc sections |
| ON UPDATE CASCADE | Code change → automatic update of linked docs (per-type strategy) |
| CHECK constraint | Git hooks blocking commits with stale documentation |
| WAL log | `changelog` table recording every symbol mutation |

Symbol identity is the key idea. A symbol's fully-qualified name
(`file::name`) plus its language and kind produces an ID that survives
refactoring: when `login()` moves to `auth/session.ts`, the signature hash
changes but the identity-tracking in Codegraph (or the builtin extractor's
heuristics) lets DocRelay follow it, and the doc links follow too.

## Database schema (SQLite, WAL mode)

The database lives at `.git/docrelay.db` (local state, never committed).

- **symbols** — one row per discovered code symbol (id, name, kind, project,
  location, signature hash, timestamps)
- **doc_sections** — one row per parsed documentation section (id, file,
  anchor, content hash, doc type, status: `in_sync` / `stale` / `pending`)
- **mappings** — foreign keys with `ON DELETE CASCADE`; review status:
  `auto` (generated), `confirmed` (human-approved), `rejected`; plus a
  `confidence` score recording the auto-link evidence strength (0.4 prose
  mention … 1.0 exact heading), refreshed on every scan. Staleness cascades
  (a signature change marking docs stale) travel only through `confirmed`
  mappings or `auto` mappings with confidence ≥ 0.7 — weak auto links are
  review candidates and never block commits on their own
- **changelog** — append-only record of symbol mutations and sync outcomes
- **review_history** — append-only audit trail of confirm/reject decisions
  (actor-attributed); deliberately has **no** foreign keys so the trail
  survives deletion of the referenced entities
- **metadata** — key/value store (schema version, last scan time)

Foreign keys are enforced (`PRAGMA foreign_keys = ON`), so deleting a symbol
or doc section cascades to its mappings automatically (`review_history`
excepted, by design).

## Pipeline

```
code files ──▶ extractors ──▶ symbols table ──┐
                                               ├─▶ auto-linker ──▶ mappings
doc files ───▶ doc parser ──▶ doc_sections ───┘
                                               │
        change detection ◀─────────────────────┘
               │
               ▼
        sync engine ──▶ per-type strategy ──▶ inline / standalone /
                                              generated / architecture
```

1. **Extraction** — `CodegraphExtractor` when Codegraph is available,
   otherwise the builtin regex extractor. The codegraph extractor enumerates
   symbols by reading the index database (`.codegraph/codegraph.db`)
   directly — exhaustively, not via the relevance-ranked `codegraph_explore`
   retrieval API — and re-captures signatures from source with the exact
   routine the builtin extractor uses, so switching extractors never
   registers as a repository-wide signature change. A missing or broken
   index falls back to the builtin extractor automatically.
2. **Doc parsing** — pluggable parsers for Markdown, reStructuredText,
   AsciiDoc, and HTML, producing sections with `codeRefs` (backtick
   references, `link:`/`xref:` annotations, inferred mentions).
3. **Auto-linking** — matches doc references to symbols by name, with
   disambiguation by file stem and confidence scoring; ambiguous matches
   are left unreviewed rather than guessed. Each completed pass also
   prunes `auto` mappings the current evidence no longer justifies
   (confirmed/rejected rows are never touched), so links created by older
   looser scorers or edited-away doc text do not accumulate.
4. **Change detection** — scans compare signature hashes; changed symbols
   flip linked docs to `stale` per the CASCADE model. Two guards keep a
   broken scan from masquerading as mass change: `scan` warns when a full
   scan re-discovers only a fraction of the tracked symbols, and `gc`
   refuses to run on such a collapse outright (see the `gc` command).
5. **Sync engine** — routes each stale section to its strategy:
   - `inline` rewrites the docstring/JSDoc in the source file (state-machine
     based, no regex-fragile edits; generated sections carry a hash guard)
   - `standalone` rewrites Markdown-style sections (or `prompt`/`mark_stale`)
   - `generated` re-runs the detected generator (TypeDoc, OpenAPI)
   - `architecture` is only ever flagged for human review

## Surfaces

| Surface | Entry point | Consumers |
|---------|-------------|-----------|
| CLI (23 commands) | `doc-relay` / `docrelay` binaries | humans, CI, shell-driven agents |
| MCP server (16 tools) | `doc-relay mcp` (stdio) | MCP-capable AI agents |
| Git hooks (4) | `.git/hooks/` | every commit/push |
| Watch daemon | `doc-relay watch [--daemon]` | long-running local sync |

All four surfaces share the same `src/tools/` implementations, so behavior
is identical whether a human, a hook, or an agent drives it.

## Failure philosophy

- **Fail open where blocking would be worse**: git hooks skip their checks
  (with a warning) when the project is uninitialized or the DB is locked.
- **Fail closed where correctness matters**: a database error during
  `check` is reported as unhealthy, never as "all docs in sync".
- **Never guess mappings**: ambiguous auto-link candidates stay unreviewed;
  only explicit or high-confidence links are created.
- **Sanitize at boundaries**: error messages shown to MCP/CLI clients never
  contain absolute paths; full details stay in server-side logs.
