# Changelog

All notable changes to DocRelay are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-28

### Added
- `doc-relay mcp` CLI subcommand that starts the MCP server on stdio, so the
  published package can be launched directly from agent MCP configs
  (`npx -y doc-relay mcp`). Previously the MCP server could only be started
  with `node dist/index.js` from a source checkout.
- `docrelay` binary alias alongside `doc-relay` for global installs.
- `LICENSE` (MIT), `CHANGELOG.md`, and standard package metadata
  (`engines`, `repository`, `keywords`, `homepage`, `bugs`).
- ESLint 9 flat config (`eslint.config.js`); `npm run lint` works again.
- CI workflow (`.github/workflows/ci.yml`): lint, build, test, and CLI smoke
  test on Node 20 and 22.

### Fixed
- Agent integration (`.mcp.json`, CLAUDE.md/OPENCODE.md/generic instructions)
  referenced `npx docrelay`, which is not a published npm package — generated
  MCP configs could not start the server. Now uses `npx -y doc-relay mcp`.
- Dogfood workflow installed the outdated published package from npm instead
  of building the current source.
- Removed ~150 lines of dead hook functions (`preCommitHook`,
  `postCommitHook`, `prePushHook`) superseded by shell-script hooks.
- Removed the vestigial `strict` parameter from `docrelayCheck()`; strict
  gating lives in CLI/MCP callers.
- Resolved all ESLint errors (useless escapes, unused vars, dead params).

## [0.3.0] - 2026-08-07

### Added
- Codegraph fallback to the builtin regex extractor when the Codegraph MCP
  server is unavailable.
- Review cleanup tooling and more robust git hooks.

### Fixed
- Codegraph explore parsing, `health` last-scan false positive, emoji-free
  output.
- `scan` output no longer leaks internal `scannedIds`; `autoLink` reports
  `alreadyLinked` correctly.

## [0.2.5] - 2026-06-24

Last published release on npm. See `UPGRADE.md` for the historical v0.2.x
upgrade plan (error codes, health checks, config validation, incremental
scanning, watch daemon mode).
