# DocRelay CLI Reference

The CLI is available as both `doc-relay` and `docrelay` (identical binaries).
All commands operate on the current project (the nearest directory containing
`.docrelay/config.yaml`, or `DOCRELAY_PROJECT_ROOT` if set).

## Setup

### `init [--no-hooks] [--no-scan] [--no-integrate] [--force]`
One-step setup: config, database, git hooks, agent integration, first scan.
`--force` overwrites existing config and hooks.

### `install-hooks [--force]`
Install (or reinstall) the git hooks in `.git/hooks/` without the other
init steps.

### `integrate [--agent <name>] [--dry-run] [--list]`
Detect your AI coding agent (claude-code, codex, cursor, opencode, hermes,
gemini, antigravity, kiro, oh-my-pi) and write its DocRelay configuration
(`.mcp.json` plus a rules-file section). `--list` shows detected agents;
`--dry-run` previews without writing. See
[mcp-integration.md](mcp-integration.md).

## Inspection

### `status [--format json|markdown]`
Health dashboard: symbol count, linked %, stale doc count, watch state.

### `health [--format json|markdown]`
8-point system check: config validity, DB readability/writability, git hooks,
codegraph availability, scan freshness, and more. Exits 1 when unhealthy.

### `check [--strict] [--file <file>] [--format json|markdown|ci|shields]`
List stale documentation sections. `--strict` exits 1 when anything is stale
(used by the git hooks and CI). `--format shields` prints a shields.io
endpoint JSON payload for documentation-health badges (see
[CI/CD integration](ci.md#status-badges)). Resolve stale sections with
[`sync`](#sync---symbol-id--sync---all-stale), or with
[`ack`](#ack---doc-id--ack---all) when the content is already accurate.

### `impact <paths...> [--format json|markdown|ci]`
Show which documentation sections are affected by the given changed files.
Accepts multiple paths (e.g. from `git diff --name-only`).

### `diff <symbol_id> [--format json|markdown]`
Show the changelog for a symbol (signature changes, renames, sync events).

### `history [--limit n] [--symbol <id>] [--format json|markdown]`
Show the review history: an append-only audit trail of every confirm/reject
decision, with actor attribution (`cli` or `mcp`). Newest first, `--limit`
defaults to 50 (max 1000). Entries survive deletion of the referenced
mapping, symbol, or doc section — deleted entries fall back to raw IDs.

### `review [--format markdown|json|detailed] [-S|--side-by-side] [--cleanup]`
Audit mapping quality: unlinked symbols, orphaned doc sections, implied
references. `--cleanup` deletes orphaned sections (whose files are gone),
their cascaded mappings, and rejected mappings older than 30 days.

## Mutation

### `scan [--no-docs] [--dry-run] [--incremental]`
Scan code and docs, update the database, and run the auto-linker.
`--incremental` skips files unchanged since the last scan — including
doc ingest and auto-linking, which are delta-filtered the same way, so
an unchanged project re-scans in a fraction of the full-scan time;
`--dry-run` previews without writing.

### `sync --symbol <id>` | `sync --all-stale`
Apply CASCADE updates to documentation linked to a symbol (or every stale
section). Behavior per doc type is configured via `strategies` in
[config.yaml](configuration.md).

### `link <create|delete> --symbol <id> --doc <id> [--type <rel>]`
Create or delete a symbol↔doc mapping manually. Relationship types:
`describes` (default), `references`, `generates`, `contracts`.
Creating the same mapping twice is an idempotent upsert.

### `confirm [--symbol <id> --doc <id> [--type <rel>]] [--all]`
Mark auto-generated mappings as human-confirmed.

### `reject [--symbol <id> --doc <id> [--type <rel>]] [--all] [--pattern <text>]`
Mark auto-generated mappings as rejected. `--pattern` rejects every mapping
whose symbol name contains the given substring.

### `ack --doc <id>` | `ack --all`
Acknowledge stale doc sections as accurate after manual review — sets their
status back to `in_sync`. Use this when a section was staled by a linked
symbol change but its content needs no edits (for example a loose auto-link
to a symbol the section never quotes). `confirm`/`reject` operate on
mappings and do not clear section staleness; `ack` is the missing piece of
the sync workflow: run `sync`, review what it could not rewrite, then `ack`
the sections that are already accurate.

### `gc [--dry-run] [--force]`
Garbage-collect symbols no longer found in the codebase. Two-pass: stale
first, delete on the next run — nothing disappears without a warning period.

**Scan-collapse guard**: if the pre-GC scan re-discovered fewer than half of
the tracked symbols (and the database tracks at least 20), GC assumes the
extractor saw a broken or stale view of the repo — not a real mass
deletion — and refuses to run (exit 1, no changes, dry runs included).
Re-run `doc-relay scan` (or `codegraph sync` when using Codegraph) and
retry; pass `--force` only when the mass deletion was intentional.

## Automation

### `watch [--debounce <ms>] [--daemon]`
Watch code and doc directories; re-scan and re-link on change. `--daemon`
writes `.docrelay/watch.pid` for process managers.

### `annotate-commit <commit-msg-file>`
Append a DocRelay summary line to a commit message (used by the
prepare-commit-msg hook).

### `export-mappings`
Write `.docrelay/mappings.json` for CodeGraph's `doc_refs` integration.

## Maintenance

### `backup [--output <path>] [--keep <n>]`
Snapshot the database to `.docrelay/backup-<timestamp>.db`. Afterwards, older
backups in the same directory are pruned to the `n` most recent
(default 10; `--keep 0` disables pruning). Only `backup-*.db` files are ever
pruned.

### `restore <backup-path> [--force]`
Restore the database from a backup. The current database is first copied to
`<db>.pre-restore` as a safety net. The backup path must be inside the
project.

### `config show` | `config validate`
`show` prints the resolved config (defaults merged with your overrides);
`validate` pre-flights `.docrelay/config.yaml` for common misconfigurations.

### `reset [--force]`
Delete the DocRelay database and re-run migrations (destructive).

### `update`
Update the globally-installed DocRelay to the latest npm release.

### `mcp`
Start the MCP server on stdio. Agent configs invoke this for you — see
[mcp-integration.md](mcp-integration.md).

## Environment variables

- `DOCRELAY_PROJECT_ROOT` — operate on a different project directory than
  the current working directory.
- `DOCRELAY_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` — disable the background
  npm update check (useful for CI and offline environments).

## Exit codes

- `0` — success (or, for `check`/`health`, everything healthy)
- `1` — failure; for `check --strict` specifically: stale docs found
