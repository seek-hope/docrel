# Configuration Reference

DocRelay is configured through `.docrelay/config.yaml` in your project root.
Every field is optional; missing fields fall back to the defaults shown below.

```yaml
# Schema version — bump only when DocRelay asks you to (used for migrations)
version: 1

# Project name (defaults to the directory name)
project: my-project

# Documentation paths — directories (walked recursively) or single files
doc_dirs:
  - docs
  - README.md

# Code directories scanned recursively for symbols
code_dirs:
  - src

# What to do when linked code changes, per documentation type:
strategies:
  inline: auto_update       # docstrings/JSDoc in source files
  standalone: auto_update   # markdown/rst/adoc/html sections
  generated: auto_update    # TypeDoc/OpenAPI output (re-runs the generator)
  architecture: mark_stale  # ADRs and design docs

# Optional Codegraph backend tuning
codegraph:
  command: codegraph   # binary name or path (must pass safety validation)
  maxFiles: 50         # deprecated — symbol enumeration now reads the codegraph
                       # index directly; retained for config compatibility
```

## Strategies

| Strategy | Behavior when linked code changes |
|----------|-----------------------------------|
| `auto_update` | Rewrite the doc section automatically |
| `mark_stale` | Flag the section as stale; a human (or agent) reviews |
| `prompt` | Suggest the change without applying it (`standalone` only) |
| `ignore` | Leave the doc type alone entirely |

Per doc-type allowed values:

- `inline`: `auto_update`, `mark_stale`, `ignore`
- `standalone`: `auto_update`, `mark_stale`, `prompt`, `ignore`
- `generated`: `auto_update`, `mark_stale`, `ignore`
- `architecture`: `mark_stale`, `ignore`

## Validation

Run `doc-relay config validate` to pre-flight your config. It reports:

- **errors** for code directories that don't exist or escape the project root
- **warnings** for doc paths that don't exist (many projects have no `docs/`
  directory — scanning treats missing paths as `skippedMissing`, not failures)
- a **warning** when `version` is newer than the installed DocRelay supports

Configs with an *older* schema version are migrated automatically: the stale
`version` field is stripped and the remaining fields are merged over defaults
(with a warning telling you to update the file when convenient).

Invalid YAML or schema-invalid values never crash a run — DocRelay logs a
warning and falls back to defaults for that file.

## What DocRelay writes where

| Path | Contents |
|------|----------|
| `.git/docrelay.db` | the SQLite database (WAL mode) — delete with `doc-relay reset` |
| `.docrelay/config.yaml` | your configuration |
| `.docrelay/mappings.json` | export for CodeGraph's `doc_refs` (`export-mappings`) |
| `.docrelay/backup-*.db` | database snapshots (`backup`, auto-rotated) |
| `.docrelay/watch.pid` | watch daemon PID (`watch --daemon`) |
| `.docrelay/watch-failed` | marker written when a watch scan fails |

The database lives inside `.git/` deliberately: it is local state, never
something to commit. Add `.docrelay/` to your `.gitignore` (DocRelay does not
modify your ignore files for you).
