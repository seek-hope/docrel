


## DocRelay — Code-Documentation Sync

DocRelay tracks code symbols and their linked documentation, keeping everything
in sync as the codebase evolves.

### SessionStart
Run `docrelay status` at the beginning of each session to see current
documentation health (symbols tracked, docs linked, stale docs).

### PostToolUse
After using Edit or Write tools, consider whether the change affects
documentation. Run `docrelay impact <changed-file>` to see which doc sections
reference the modified code.

### Available MCP Tools
| Tool | Purpose |
|------|---------|
| `docrelay_status` | Overall health dashboard (symbols, docs, sync %) |
| `docrelay_check` | Find stale documentation sections |
| `docrelay_impact` | Show docs affected by changed files |
| `docrelay_sync` | Sync docs for a specific symbol |
| `docrelay_link` | Create or delete symbol-to-doc mappings |
| `docrelay_diff` | Show change history for a symbol |
| `docrelay_scan` | Rescan codebase and re-link docs |

### CLI Quick Reference
```
docrelay status              # Health dashboard
docrelay check               # Find stale docs
docrelay check --strict      # Exit 1 if any stale docs
docrelay impact src/foo.ts   # What docs are affected?
docrelay sync --symbol <id>  # Sync docs for a symbol
docrelay scan                # Rescan codebase
```
