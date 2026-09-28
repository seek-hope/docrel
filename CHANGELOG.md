# Changelog

All notable changes to DocRelay are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-28

### Added
- Release workflow (`.github/workflows/release.yml`): tag push verifies the
  version, runs all gates, publishes to npm with provenance, and creates a
  GitHub Release with the packed tarball (requires the `NPM_TOKEN` secret).
- Backup rotation: `doc-relay backup --keep <n>` prunes older `backup-*.db`
  files after a successful backup (default 10, `0` disables), so `.docrelay/`
  no longer grows unbounded.
- Coverage gate: `npm run coverage` (v8 provider) with baseline thresholds
  (44/38/50/47) enforced in CI.
- User documentation set in `docs/`: getting started, CLI reference,
  configuration, MCP integration, architecture — linked from both READMEs
  and now tracked by DocRelay's own scan.
- Type-aware linting (typescript-eslint `recommendedTypeChecked`) and a
  `npm run typecheck` gate covering src and tests; both wired into CI.
- `doc-relay mcp` CLI subcommand that starts the MCP server on stdio, so the
  published package can be launched directly from agent MCP configs
  (`npx -y doc-relay mcp`). Previously the MCP server could only be started
  with `node dist/index.js` from a source checkout.
- `docrelay` binary alias alongside `doc-relay` for global installs.
- `LICENSE` (MIT), `CHANGELOG.md`, and standard package metadata
  (`engines`, `repository`, `keywords`, `homepage`, `bugs`).
- ESLint 9 flat config (`eslint.config.js`); `npm run lint` works again.
- CI workflow (`.github/workflows/ci.yml`): lint, build, test, and CLI smoke
  test on Node 22 and 24.

### Security
- Resolved all 14 npm audit findings (1 critical, 7 high, 6 moderate) by
  upgrading vitest 2 → 5, vite → 8, and refreshing transitive dependencies.

### Changed
- Minimum Node.js version is now 22.12 (Node 20 reached EOL in April 2026).

### Fixed
- Scan and doc-ingest now wrap their per-directory/per-batch database writes
  in a single transaction instead of auto-committing every row — first scan
  of a 10,000-symbol project is ~21% faster (1901ms → 1502ms in
  `scripts/bench-scan.mjs`, bigger on slower disks). Completes the "batch
  INSERT" item from the v0.2.2 performance roadmap.
- Floating/misused promises in MCP-server signal handlers and the watch
  daemon's debounce loop; non-Error values could be rethrown by the codegraph
  client; `errMsg` emitted `[object Object]` for non-Error throws.
- `scan` no longer reports configured-but-nonexistent doc paths (e.g. the
  default `docs` directory) as `failedFiles` — they are now listed separately
  as `skippedMissing`, so real parse failures stay visible.
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
