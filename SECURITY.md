# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

DocRelay is pre-1.0; only the most recent release receives security fixes.

## Threat model

DocRelay reads your source code and documentation, writes to a local SQLite
database in `.git/docrelay.db`, and can rewrite documentation files when
configured with `auto_update` strategies. The main attack surfaces:

- **Path traversal**: doc dirs, doc files, and symbol locations are treated
  as hostile input. All file access goes through containment checks
  (`validatePath`, realpath resolution, symlink/dangling-symlink rejection).
- **Generated-doc execution**: `auto_update` for `generated` docs runs a
  generator command. Only an allowlist of binaries/npm scripts is executed;
  absolute paths, interpreters, and code-loading flags are rejected.
- **Malicious project files**: `.docrelayignore`, `package.json`,
  `.mcp.json`, and rules files are size-limited and parse-defensively
  (depth-limited JSON, never overwritten when unparseable).
- **MCP surface**: tool errors are sanitized before returning to the model —
  internal paths and stack traces stay in server logs.

If you find a gap in any of these (or a new one), we want to hear about it.

## Reporting a vulnerability

**Please do not open a public GitHub issue.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/seek-hope/docrel/security/advisories/new)
for this repository. Include:

- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- The DocRelay version and Node.js version you tested against

We aim to acknowledge reports within 7 days and, when a fix is ready,
credit reporters in the release notes (unless you prefer anonymity).
