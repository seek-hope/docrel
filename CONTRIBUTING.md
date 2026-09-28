# Contributing to DocRelay

Thanks for helping improve DocRelay! This document covers the development
workflow, quality gates, and release process.

## Setup

```bash
git clone https://github.com/seek-hope/docrel.git
cd docrel
npm ci        # Node.js >= 22.12 required
npm run build
```

`better-sqlite3` ships a prebuilt native binding; if your platform needs a
source build you need a C++ toolchain (`node-gyp` requirements).

## Quality gates — run all of these before pushing

| Gate | Command | What it checks |
|------|---------|----------------|
| Lint | `npm run lint` | typescript-eslint `recommendedTypeChecked` over src + tests |
| Typecheck | `npm run typecheck` | `tsc --noEmit` over src + tests |
| Build | `npm run build` | `tsc` emit to `dist/` |
| Tests | `npm test` or `npx vitest run --coverage` | vitest suite with coverage thresholds |

The coverage thresholds in `vitest.config.ts` **ratchet**: they may only go
up, never down. If your change raises measured coverage, bump the thresholds
(and the comment above them) in the same commit.

CI (`.github/workflows/ci.yml`) runs all four gates plus a CLI smoke test on
Node 22 and 24.

## Test conventions

- Unit tests live next to the area they cover: `tests/tools/`, `tests/db/`,
  `tests/utils/`, `tests/sync/`, `tests/discovery/`, …
- Integration tests in `tests/integration/` drive the real CLI binary
  (`dist/cli.js`) and the in-process MCP server
  (`createDocrelayServer` + `InMemoryTransport`).
- Use a fresh `mkdtemp` project per test with a `.git/` directory, `getDb`,
  and `runMigrations` — never touch the developer's real repository DB.
- CLI/MCP-facing changes should get coverage at the level they can break:
  unit for logic, in-process MCP for tool wiring, subprocess for commander
  plumbing.

## Dogfooding

This repository uses DocRelay on itself: a pre-commit hook runs
`doc-relay check --strict` and a post-commit hook re-scans. If your change
touches `docs/` or README files, keep them consistent or the hook will fail
the commit — that is intentional. Scan yourself with
`node dist/cli.js scan` after doc edits.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `perf:`, `chore:`.
Write the body for a future reader: what changed, why, and any measured
impact (coverage deltas, benchmark numbers).

Keep `CHANGELOG.md` (Keep a Changelog format) and, when a feature lands,
`README.md` + `README.zh-CN.md` + `UPGRADE.md` in sync — all three are
checked in review.

## Release process (maintainers)

1. Bump `version` in `package.json` **and** `DOCRELAY_VERSION` in
   `src/version.ts` (the version-sync test fails otherwise).
2. Update `CHANGELOG.md` and move items in `UPGRADE.md`.
3. Commit, tag `vX.Y.Z`, push the tag.
4. `.github/workflows/release.yml` verifies the tag matches the version,
   runs all gates, publishes to npm with provenance, and creates a GitHub
   Release. Requires the `NPM_TOKEN` repository secret.

## Reporting security issues

Please see [SECURITY.md](SECURITY.md) — do not open public issues for
vulnerabilities.
