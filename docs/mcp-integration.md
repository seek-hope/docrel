# MCP Integration (AI Agents)

DocRelay ships an MCP server so AI coding agents can query documentation
health and apply sync operations directly during a session.

## Quick setup

```bash
doc-relay integrate
```

This auto-detects your agent (Claude Code, Codex, Cursor, OpenCode, Hermes,
Gemini, Antigravity, Kiro, Oh My Pi) and writes the right configuration in
the agent's own format. Use `--list` to see what was detected and
`--dry-run` to preview.

Per-agent locations written by `integrate`:

| Agent | MCP config file | Rules file |
|-------|-----------------|------------|
| Claude Code | `.mcp.json` | `CLAUDE.md` |
| Codex | `.codex/config.toml` (`[mcp_servers.docrelay]`) | `AGENTS.md` |
| Cursor | `.cursor/mcp.json` | — (no rules file written) |
| OpenCode | `opencode.json` (`"mcp"` key, `type: "local"`) | `AGENTS.md` |
| Gemini CLI | `.gemini/settings.json` | `GEMINI.md` |
| Antigravity | `.agents/mcp_config.json` | `AGENTS.md` |
| Kiro | `.kiro/settings/mcp.json` | `.kiro/steering/docrelay.md` |
| Hermes | — (rules only) | `.pi/docrelay.md` |
| Oh My Pi | — (no MCP support) | `.pi/docrelay.md` |

Older DocRelay versions wrote some agents in the wrong format (e.g.
`OPENCODE.md` for OpenCode, `.mcp.json` for Codex). `integrate` now writes
each agent's real convention and leaves a note on legacy files it finds —
it never deletes your files.

## Manual setup

Add this to your agent's MCP configuration (`.mcp.json` for Claude Code):

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

For Codex, add the equivalent TOML table to `.codex/config.toml` (project)
or `~/.codex/config.toml` (global), and the workflow section to `AGENTS.md`:

```toml
[mcp_servers.docrelay]
command = "npx"
args = ["-y", "doc-relay", "mcp"]
```

Notes:

- The server binary is the `mcp` subcommand of the published `doc-relay`
  npm package — `npx -y doc-relay mcp` works without a global install.
- `DOCRELAY_PROJECT_ROOT` pins the project. If unset, the server uses its
  working directory and refuses to start when `.docrelay/config.yaml` is
  missing (rather than silently creating a database in a random directory).
- Set `DOCRELAY_DEBUG=1` for stack traces in server logs.

## Available tools (18)

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
| `docrelay_ack` | Acknowledge stale doc sections as accurate |
| `docrelay_diff` | Change history for a symbol |
| `docrelay_history` | Audit trail of confirm/reject decisions |
| `docrelay_scan` | Rescan codebase and docs, re-link |
| `docrelay_review` | Mapping audit (unlinked symbols, orphans) |
| `docrelay_integrate` | Write agent integration configs |
| `docrelay_watch` | List paths the CLI watcher would watch |
| `docrelay_watch_status` | Watcher state (events, errors, last event) |
| `docrelay_refresh` | Lightweight incremental poll for agents |
| `docrelay_health` | 13-point system health check |

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
