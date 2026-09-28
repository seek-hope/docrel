# MCP Integration (AI Agents)

DocRelay ships an MCP server so AI coding agents can query documentation
health and apply sync operations directly during a session.

## Quick setup

```bash
doc-relay integrate
```

This auto-detects your agent (Claude Code, Codex, Cursor, OpenCode, Hermes,
Gemini, Antigravity, Kiro, Oh My Pi) and writes the right configuration:
an entry in `.mcp.json` plus a DocRelay section in your agent's rules file
(`CLAUDE.md`, `AGENTS.md`, etc.). Use `--list` to see what was detected and
`--dry-run` to preview.

## Manual setup

Add this to your agent's MCP configuration (e.g. `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "docrelay": {
      "command": "npx",
      "args": ["-y", "doc-relay", "mcp"],
      "env": {
        "DOCRELAY_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

Notes:

- The server binary is the `mcp` subcommand of the published `doc-relay`
  npm package — `npx -y doc-relay mcp` works without a global install.
- `DOCRELAY_PROJECT_ROOT` pins the project. If unset, the server uses its
  working directory and refuses to start when `.docrelay/config.yaml` is
  missing (rather than silently creating a database in a random directory).
- Set `DOCRELAY_DEBUG=1` for stack traces in server logs.

## Available tools (17)

| Tool | Purpose |
|------|---------|
| `docrelay_status` | Health dashboard (symbols, docs, sync %) |
| `docrelay_check` | Find stale documentation (`strict`, `file` options) |
| `docrelay_impact` | Docs affected by changed files |
| `docrelay_sync` | Sync docs for one symbol |
| `docrelay_sync_all` | Sync every stale doc section |
| `docrelay_link` | Create/delete symbol↔doc mappings |
| `docrelay_confirm` | Confirm auto-generated mappings |
| `docrelay_reject` | Reject auto-generated mappings |
| `docrelay_diff` | Change history for a symbol |
| `docrelay_history` | Audit trail of confirm/reject decisions |
| `docrelay_scan` | Rescan codebase and docs, re-link |
| `docrelay_review` | Mapping audit (unlinked symbols, orphans) |
| `docrelay_integrate` | Write agent integration configs |
| `docrelay_watch` | List paths the CLI watcher would watch |
| `docrelay_watch_status` | Watcher state (events, errors, last event) |
| `docrelay_refresh` | Lightweight incremental poll for agents |
| `docrelay_health` | 8-point system health check |

## Recommended agent workflow

1. **Session start** — call `docrelay_status` to see documentation health.
2. **After editing code** — call `docrelay_impact` with the changed files to
   learn which doc sections reference the touched symbols.
3. **Apply updates** — call `docrelay_sync` per symbol (or `sync_all`), then
   review what changed with `git diff`.
4. **Before committing** — the pre-commit hook runs `check --strict`
   automatically; keep mappings honest with `docrelay_review`.

## Without MCP

Every tool has a CLI equivalent, so agents (and humans) without MCP support
can drive DocRelay through shell commands — see
[cli-reference.md](cli-reference.md).
