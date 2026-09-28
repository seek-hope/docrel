# Getting Started with DocRelay

DocRelay keeps code and documentation in sync by treating their relationship
like a database: symbols are rows, doc sections are rows, and the mappings
between them are foreign keys with CASCADE behavior.

## Prerequisites

- **Node.js ≥ 22.12**
- A git repository (DocRelay stores its database at `.git/docrelay.db`)
- Optional: [Codegraph](https://github.com/colbymchenry/codegraph) for
  richer symbol tracking. Without it, DocRelay falls back to its builtin
  regex-based extractor automatically.

## Install

```bash
npm install -g doc-relay
# Both binaries are provided: doc-relay and docrelay
```

## Initialize a project

```bash
cd your-project
doc-relay init
```

`init` performs five steps:

1. Writes `.docrelay/config.yaml` (edit `doc_dirs`/`code_dirs` if needed)
2. Creates the SQLite database at `.git/docrelay.db`
3. Installs git hooks (pre-commit, post-commit, pre-push, prepare-commit-msg)
4. Detects your AI coding agent and writes its DocRelay integration
   (`.mcp.json`, rules files) — skip with `--no-integrate`
5. Runs the first scan of code symbols and documentation

## The daily loop

```bash
doc-relay status    # health dashboard: symbols, docs, sync %
doc-relay check     # list stale documentation (add --strict in CI)
doc-relay sync --all-stale   # apply CASCADE updates to stale docs
doc-relay review    # audit unlinked symbols and orphaned sections
```

After you refactor code, ask what broke:

```bash
doc-relay impact src/auth.ts
```

DocRelay reports exactly which doc sections reference the changed symbols —
and `sync` can rewrite inline docstrings and standalone sections for you.

## With an AI agent

If you use Claude Code, Codex, OpenCode, or another MCP-capable agent, the
MCP server exposes the same operations as tools the agent can call on your
behalf. See [mcp-integration.md](mcp-integration.md).

## Housekeeping

```bash
doc-relay gc --dry-run      # preview removal of symbols gone from the code
doc-relay gc                # garbage-collect them (two-pass, safe)
doc-relay backup            # snapshot the database (auto-rotates old backups)
doc-relay health            # 8-point system check (config, DB, hooks, ...)
```

## Next steps

- [CLI reference](cli-reference.md) — every command and flag
- [Configuration](configuration.md) — `.docrelay/config.yaml` options
- [Architecture](architecture.md) — how the relational model works
