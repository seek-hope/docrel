# Changelog

All notable changes to DocRelay are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-28

### Added
- npm v12 forward compatibility: `allowScripts` declaration for
  `better-sqlite3` in package.json (npm v12 skips install scripts by
  default, which would leave the native binding unbuilt on fresh
  installs), plus a native-module smoke test step in the CI and release
  workflows that fails fast if the binding is ever missing. The CLI entry
  point is now a thin shim (`src/cli.ts` -> `src/cli-main.ts`) that
  detects a missing native binding at startup — walking the error cause
  chain — and prints remediation steps instead of a raw "Could not locate
  the bindings file" stack; install docs cover the
  `--allow-scripts=better-sqlite3` flag for global installs.
- Community/engineering hygiene: `CODE_OF_CONDUCT.md` (Contributor
  Covenant 2.1), `.editorconfig`, and `.gitattributes` (LF normalization).
- Status badges + GitLab CI template (completes the 0.3.2 CI/CD roadmap
  item): `doc-relay check --format shields` prints a shields.io endpoint
  JSON payload (`docs: in sync / N stale`), `docs/templates/gitlab-ci.yml`
  ships a copy-paste pipeline (check job + GitLab Pages badge job), and the
  new [CI/CD integration guide](docs/ci.md) covers GitHub Actions, GitLab
  CI, and badge publishing.
- Review history: every confirm/reject decision is recorded in a new
  append-only `review_history` table (schema v5) with actor attribution
  (`cli` vs `mcp`). Inspect it with `doc-relay history [--limit n]
  [--symbol id] [--format json|markdown]` or the `docrelay_history` MCP
  tool. History rows deliberately have no foreign keys, so the audit trail
  survives deletion of the referenced mapping, symbol, or doc section.
- Release workflow (`.github/workflows/release.yml`): tag push verifies the
  version, runs all gates, publishes to npm with provenance, and creates a
  GitHub Release with the packed tarball (requires the `NPM_TOKEN` secret).
- Backup rotation: `doc-relay backup --keep <n>` prunes older `backup-*.db`
  files after a successful backup (default 10, `0` disables), so `.docrelay/`
  no longer grows unbounded.
- Coverage gate: `npm run coverage` (v8 provider) with ratcheting thresholds
  (currently 95.1/88.1/94.9/96.05) enforced in CI.
- User documentation set in `docs/`: getting started, CLI reference,
  configuration, MCP integration, architecture — linked from both READMEs
  and now tracked by DocRelay's own scan.
- Type-aware linting (typescript-eslint `recommendedTypeChecked`) and a
  `npm run typecheck` gate covering src and tests; both wired into CI.
- Test suites for `review`, `watch`, `update-check`, `agents/context`,
  `git/hooks`, `extractors/codegraph`, `codegraph/client`, `sync/generated`,
  `sync/standalone`, `sync/inline` utilities, and sync-engine strategy
  branches (710 new tests, 1007 total):
  implied-reference detection, path-traversal skips, orphan cleanup safety,
  watcher lifecycle/PID file/stale-on-delete, debounced re-scan, and deterministic mocked-chokidar event handling (ignored-file skips, debounce-group cancellation, doc-change re-scan, rescan/removal failure markers, watcher error/close events, timer cleanup on stop, and missing-chokidar/generic startup failures), the review tool (implied-scan directory/size/line-cap/heading/short-name guards, format sections for implied/unreviewed/orphaned entries, detailed 200-mapping overflow, snippet extraction through nested directories, oversized source/doc files, line-cap guards, first-occurrence fallback, and missing-anchor/header rendering), docrelayDiff report assembly (changelog rows, missing-doc fallbacks, db_error), and scan-fallback file/nested-dir/symlink-loop handling), impact input validation (batch cap, empty/overlong/escaping paths, LIKE sibling rejection, cross-file dedup, per-file error sanitization), and the health checks (codegraph probe outcomes, stale-ratio thresholds, >24h last-scan, degraded-but-functional summary, and the sanitized-failure wrapper via a fault-injecting db proxy), and the db layer itself (doc-section validation/filters/mark-* guards, symbol validation/kind-defaulting/circular-metadata serialization, mapping empty-id guards/JSON export, and getDb gitdir resolution — worktree, in-root, escaping, malformed, oversized .git files, WAL/SHM permission hardening, and path-sanitized init errors), and the config/ignore utilities (projectRoot file rejection, oversized config/ignore files, >10k-line ignore files, bare negations, **-placement and ? wildcards, non-numeric schema versions, doc_dirs traversal rejection), and auto-linker edge paths (low-confidence bodytext accounting, snake_case/underscore code-like names, FK-violation silent skips, non-constraint mapping failure warnings, pass-1/pass-2 timeout partial results, minConfidence validation, ambiguous same-name stem linking, malformed-section batch isolation), and the builtin extractor (root-escape/missing/symlinked code dirs, file-as-dir, hidden/vendor subdirectory skips, >10 MB and >100k-line file guards, rule-less .pyi stubs, incremental since-cutoff, EACCES read failures, single-line JSDoc and python docstring capture), the scanner markSignatureChanged TOCTOU recovery (concurrent-delete warn and direct changelog insertion, via a mocked db/symbols), and doc-scanner subdirectory recursion plus single-file symlink containment, and doc-parser branch paths (100k-line guards across all four parsers, preamble capture before the first heading, 10 MB HTML size limit, 50k-heading/10k-ref/5k-pre-line truncation caps, backtick-call bracket counting with nested and escaped backticks, scan-ahead paren adjustment, depth-zero closing after a failed scan-ahead, unterminated calls, snake_case bodytext candidates, heading backtick refs, unbalanced heading parens, and RST code-block termination), and inline-sync guard paths (directory/oversized/unreadable targets, empty/oversized signature and docstring inputs, comment-inflated occurrence counts, ambiguous-or-missing signatures refusing partial updates, post-validation uniqueness, temp-dir and atomic-write failure injection, 100k-match counting abort, python/go/rust docstring extraction edges — no-colon headers, inline comments, blank-and-comment body walks, unterminated docstrings, 100k-line extraction guards, blank/code-line comment-block termination, mismatched old comments, regex-literal vs division disambiguation, string escapes at end-of-content, 100k-line and 2000-line docstring caps, tag-block resets, and destructured/string-typed/template-typed parameter splitting), the
  update-check cache/registry matrix, health-context formatting, git hook
  installation (worktree resolution, in-root gitdir handling, shell quoting, PATH fallback, binary-prefix validation, --version probing, unwritable hooks directories, and partial-install rollback), and
  codegraph kind/language mapping, the engine write paths (inline
  auto_update signature rewrite, codegraph-query signature source, doc/file
  mismatch repair, docstring/raw-signature failure guards, standalone
  surgical replacement, agent-pre-rewritten hash accounting, stale→in_sync
  mtime transition, generated regeneration failure), doc-scanner
  containment (path escape, symlinked dir/file escape, single-file doc_dirs,
  .docrelayignore dir/file patterns, extension allowlist, hidden/vendor dir
  skips, 10 MB size limit, EACCES handling, non-regular files), agent
  integration defensive paths (oversized/null/invalid .mcp.json preserved,
  oversized rules files skipped, cursor/gemini/kiro/antigravity/hermes
  variants, dry-run no-write guarantees, idempotency), MCP handler paths
  (review cleanup through the tool boundary, integrate dry-run reporting,
  and the sanitizeError contract — throwing tools return a generic message
  with no path disclosure), and the generated-doc command allowlist
  (interpreter/path/code-loading-flag rejection, npm-script resolution,
  OpenAPI/TypeDoc detection heuristics, and engine coverage for
  ignore/prompt/mark_stale strategies, generated-doc fallback, standalone
  auto_update failure modes, changelog applied/failed accounting, and
  syncAllStale dedup, and the codegraph client's tool-call plumbing
  (explore/impact/search/signature extraction, liveness-failure reconnect,
  preflight binary validation matrix), and the standalone-doc write path
  (single-occurrence replacement guards, CRLF alignment, $-pattern
  literalness, mode preservation, fenced-code-block heading handling,
  section-scoped signature replacement), and the comment/string stripping
  state machines plus docstring regeneration (narrative preservation,
  param-description harvesting, generic-constraint parameter parsing,
  string-default comma handling), and the sync-engine signature extractor
  and error paths (Allman/overload/multi-line/generic-constraint signature
  assembly, block-comment and string-splice decoys, 500-char/100k-line/10 MB
  extraction guards, dangling mappings, fault-injected mark-* failures via a
  db proxy, standalone surgical dedup/genuine-failure/hash-accounting/mtime
  paths, unknown pre-union doc_types, sanitized per-doc and catastrophic
  error wrappers, multi-line method standalone rewrites, and a vacuous
  inline-sync test assertion repaired to match the real failure prefix),
  the standalone-doc write path to 100% branch coverage (fence non-closing
  variants across all three parsers, fd-realescape and non-Linux fallbacks,
  ELOOP/EIO/ENOENT fault injection, oversized anchors/sections/oldContent,
  post-validation ambiguity, temp-dir and atomic-write failures, CRLF
  alignment, and non-Error throw formatting), the generated-doc driver
  (npm-run execution, spawnSync throw stringification, package.json escape
  and depth-scan edges, unreadable/traversal/scalar package.json, content
  sniffing fallbacks and ambiguity warnings, whitespace script skips), and
  the generated-hash refresh race errors), and the codegraph client
  connection plumbing (liveness in-flight guards and single-retry
  semantics, concurrent-null detection, binary resolution via fake PATH
  binaries — empty which, non-file/vanishing/swapped targets, prefix
  rejection, TOCTOU re-stat — SDK connect success/error/timeout and
  generation races, preflight diagnostics with stateful version probes and
  cross-call version caching, isAvailable hang timeouts with close-failure
  swallow, liveness-retry and 5-minute tool-call timeout timers, and parse
  edges including legacy-format dedup, blast-radius line-0 recovery,
  non-numbered fence lines, and null/text-less tool content), the link
  constraint diagnostics (both-endpoints-exist generic violation, failing
  diagnostic query, non-constraint internal error, and best-effort review
  history surviving an INSERT failure), the status tool's sanitized
  zero-report on database failure, the getDb .git accessibility fallback
  (EACCES warning vs silent non-permission fallback to .docrelay), and
  doc-scanner fault injection (stat failure/vanish after resolution and
  per-file realpath failure during validation), schema legacy-column
  migration (duplicate-ALTER swallow via PRAGMA, genuine re-add, and
  rethrow when the column is truly missing), closeDb eviction semantics,
  doc-walk fault tolerance (unreadable subdirectory via real permission
  denial, duplicate realpath dedup across symlinks, per-entry realpath
  failure), and update-check cache failure latches (unwritable cache
  directory and unwritable cache file each warn exactly once), and an
  in-process CLI suite that imports cli.ts fresh per command (argv
  injection, mocked process.exit, unavailable-codegraph config) covering
  init, status, check formats and file filtering, impact, sync guards,
  link/confirm/reject/history flows, bulk confirm, export-mappings, gc,
  backup/restore/reset, config show/validate, install-hooks idempotency,
  annotate-commit containment, scan variants, review formats, integrate
  list/validation/dry-run, and the update command's registry and
  which-missing aborts, plus index.ts process bootstrap (stdio startup on
  a mocked transport, SIGINT/SIGTERM/uncaughtException/unhandledRejection
  shutdown semantics with exit-code escalation, and initDeps failure
  exits, direct-invocation auto-start success and fatal paths, and
  DOCRELAY_DEBUG stack logging), the CLI mcp bootstrap and readline
  confirmation prompts (restore cancel/proceed), integrate dry-run
  already-configured detection for opencode and cursor, and scan-fallback
  symlink realpath dedup, and the builtin extractor's fault-injected fs
  failures (unresolvable/unstatable code dir, unreadable subdirectory via
  real permission denial, entry realpath failure, symlink realpath dedup,
  root-escaping source file, unresolvable/unopenable source file,
  incremental stat failure) plus extractTsJsDoc scan-up edges (earlier
  block close, blank interior lines, interrupting non-comment line, and
  plain /* non-doc blocks), and a final in-process CLI batch covering
  bulk reject --all, annotate-commit edges (oversized message skip,
  stat-failure abort, hook-already-installed detection), a real
  non-dry-run integrate of claude-code, the reset confirmation prompt
  (cancel preserves the database, confirm re-initializes it), review
  --cleanup, and a fault-injected link failure.
- In-process MCP server tests (`tests/integration/mcp-server.test.ts`):
  drives the real server through the official SDK client — tool listing,
  status/check/scan/link/confirm/review round-trips, check file-filter
  semantics, impact/diff/watch/refresh/health, and error resilience.
- CLI end-to-end smoke suite (`tests/integration/cli.test.ts`): runs the real
  `dist/cli.js` binary in a throwaway project covering `--help`/`--version`,
  uninitialized-project guards, `init`, `scan` (incl. `--dry-run`), `status`
  (json/markdown), `check --strict` with `--file` filtering,
  `export-mappings`, `review`, `backup`, `gc`, and `health`.
- `DOCRELAY_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` environment opt-out for
  the background npm update check (CI/offline use).
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
- Publish verification: `docs/` now ships in the npm tarball (README's
  relative doc links resolve on npmjs.com and offline), and the packed
  package was install-tested end-to-end — `npm install <tarball>` in a
  clean project followed by init/scan/status/check smoke tests. A
  welcome side effect of the better-sqlite3 v13 upgrade: it bundles
  N-API prebuilds for 8 platform targets, so npm >= 12 global installs
  work with no build step on major platforms (the CLI shim remains as
  the safety net elsewhere).
- Dependency overhaul: commander 13→15, chokidar 4→5, better-sqlite3
  12→13 (+ @types/better-sqlite3 7→9), eslint 9→10 (+ @eslint/js 10);
  removed the unused `simple-git` dependency. ESLint 10's new
  `preserve-caught-error` / `no-useless-assignment` rules were adopted by
  fixing all 16 flagged sites (error `cause` chains preserved at 11
  rethrow sites, 5 dead assignments removed). Deliberately deferred:
  `typescript@7` (typescript-eslint peer range is `<6.1.0`) and
  `@types/node@26` (types track the supported runtime floor, Node 22).
- CLI decision logic (`errMsg` sanitization, extractor selection,
  codegraph→builtin scan fallback, init detection) extracted from `cli.ts`
  into a new unit-tested `src/cli-support.ts`; `cli.ts` is now thin
  commander wiring covered end-to-end by the subprocess smoke suite.
- `src/index.ts` (MCP server) refactored into a testable
  `createDocrelayServer(deps)` factory plus an explicit `main()` — tool
  registrations no longer depend on module-level side effects, and the
  server can be driven in-process over an in-memory transport.
  `doc-relay mcp` and direct `node dist/index.js` execution are unchanged.
- Minimum Node.js version is now 22.12 (Node 20 reached EOL in April 2026).

### Fixed
- The MCP server's shutdown exit-code escalation dropped crashes that
  arrived after a clean shutdown had already started: `shutdown(1)`
  following `shutdown(0)` updated the internal `exitCode` variable (read
  only by the 500ms force-exit timer) but returned before assigning
  `process.exitCode`, so a crash during a graceful shutdown still exited 0
  whenever the event loop drained before the timer fired. The escalated
  code is now applied to `process.exitCode` on every call.
- A non-Error throw from `spawnSync` (e.g. a thrown plain object) made
  `updateGeneratedDoc` return `output: undefined`, which callers then
  interpolated into error reports as the literal string "undefined"; the
  catch path now stringifies non-Error throws.
- Inline sync failed for every symbol whose signature contains a string or
  template literal (e.g. default parameter values like `a = "x")"`):
  `updateInlineDoc` counted the verbatim signature against comment+string-
  stripped content, so the occurrence count was always 0 and the sync
  aborted with "signature missing from source". The signature is now
  string-stripped (comments kept, so crafted comment-trapped signatures
  still fail validation) before both the pre-count and post-validation.
- Inline sync never ran for multi-line class method definitions
  (`login(\n  user: string\n)`): `extractDocstring`'s symbol regex required
  the closing paren and an opening brace/colon on a single line, so the
  docstring lookup returned null and the sync bailed with "Could not
  extract existing docstring". An anchored opener pattern (optional member
  modifiers + `name(` with no closing paren on the line) now recognizes
  multi-line definitions while still excluding prefixed call sites.
- Detailed review doc snippets displayed the heading line number off by one
  (`// docs/file.md:N+1` instead of `N`): `readDocSnippet` added one to an
  already 1-based line count.
- A malformed extractor result (e.g. a symbol with a null file from a changed
  codegraph response) no longer aborts the entire directory scan: the
  `.docrelayignore` check moved inside the per-symbol guard, so the bad
  symbol is skipped with a warning and the remaining symbols are processed,
  matching the documented fault-isolation design.
- Update check no longer reports an older registry version as an available
  update when the installed build is ahead of npm (e.g. a locally built
  pre-release): the fetch path now applies the same `isNewer()` gate as the
  cached path.
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
