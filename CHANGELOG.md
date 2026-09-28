# Changelog

All notable changes to DocRelay are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-28

### Fixed
- Removed the stale `scripts/install-hooks.sh` (referenced the pre-rename
  `docrel` binary and a superseded hook flow); the maintained installer is
  the `doc-relay install-hooks` CLI command.
- Inline sync could never locate signatures in files beginning with a line
  comment (this repo's header convention): the occurrence-count haystack
  passed whole-file content to the per-line `stripCommentsAndStrings`,
  whose `//` handling stops at the first line comment — stripping the
  haystack to empty and failing every such sync with "signature missing
  from source" (latent since multi-language inline sync; exposed by the
  new index enumeration discovering string-literal constants). Added
  `stripCommentsAndStringsMultiline` (split-strip-rejoin) for whole-file
  use, with regression tests.
- `getSymbolSignature` now strips tab-separated line-number prefixes
  (`67\tcode`) in addition to pipe-separated ones (`123| code`) — current
  codegraph builds emit the tab form, and the leftover prefix failed every
  downstream signature occurrence check.
- `generateUpdatedDocstring` no longer drops docstring summaries that
  share the `/**` opener line (or entire single-line docstrings) and
  replaces them with the auto-update placeholder — opener/closer markers
  are peeled textually so narrative extraction sees pure content lines.
  Previously, fixing the two bugs above would have let sync write these
  mangled docstrings into source files.
- Auto-linker precision: three prose-word bridges that manufactured
  strong mappings out of ordinary English are closed. (1) The fuzzy
  matcher's direct-containment shortcut is gone — `main` no longer links
  every `Maintenance` section ('main' ⊂ 'maintenance'); containment of a
  ≥5-character name is still caught by the prefix/LCS floors, so only the
  sub-5-character false-positive class is blocked. (2) Those prefix/LCS
  floors rose from 4 to 5 characters — `shutdown` had matched every
  `--format json|markdown` heading through the shared 4-character
  substring 'down'. (3) The heading-substring rule now only fires inside
  identifier-like tokens (camelCase/snake_case/acronym/digit), so a
  capitalized English word that merely contains a symbol name
  ('Maintenance' ⊃ 'main') no longer scores 0.7.
- `ingestDocSections` no longer creates mappings from `bodytext` code
  references (bare identifiers heuristically spotted in prose — the
  weakest evidence class at 0.4, below the 0.5 auto-link floor): every
  full scan re-created ~33 such mappings on this repo and the new prune
  pass deleted them again, an endless create/prune churn cycle. Weak
  prose evidence is now owned solely by the scored auto-link pass.
- The auto-link scorer now understands explicit `link:`/`xref:` doc
  annotations (`link` code refs) and weights them 0.9 like backtick
  quotes; previously ingest stored them at 0.9 but the scorer knew no
  `link` case, so the prune pass would have deleted deliberate
  annotations from reStructuredText/AsciiDoc docs on every scan.

### Added
- Exhaustive codegraph symbol enumeration + scan-collapse guards (dogfood
  findings). `CodegraphExtractor` no longer misuses the relevance-ranked
  `codegraph_explore` retrieval API as an enumeration source — it reads
  Codegraph's index database (`.codegraph/codegraph.db`) directly, so scans
  capture the complete indexed symbol set (previously a tiny,
  query-dependent subset that made `gc` believe hundreds of live symbols
  had been deleted). Signatures and docstrings are re-captured from source
  with the same routines the builtin extractor uses, so switching
  extractors does not register as a repository-wide signature change, and
  coverage improves (module-level constants and methods the regex rules
  could not see). Two guards share one collapse definition: a full `scan`
  that re-discovers only a fraction of the tracked symbols prints a stale
  index warning, and `gc` now refuses to run (exit 1, dry runs included)
  when more than half of all tracked symbols went missing — pass the new
  `gc --force` only after an intentional mass deletion. `config.yaml`'s
  `codegraph.maxFiles` is deprecated (enumeration no longer pages explore
  requests) and remains accepted for compatibility.
- Auto-linker self-healing: at the end of every completed auto-link pass,
  `auto` `describes` mappings whose symbol and doc section were both
  re-evaluated are re-scored against the current evidence, and mappings
  the scorer no longer justifies are deleted (`scan`/`watch` report the
  count as `autoLink.pruned`). Previously auto-linking was append-only, so
  mappings created by a looser scorer revision — or justified by doc text
  that has since been edited away — lived forever and kept fanning
  staleness cascades through sections that no longer reference the
  symbol. Confirmed/rejected rows are never touched, a timed-out partial
  pass prunes nothing, and pairs outside the current scan's scope (e.g.
  unchanged symbols in an incremental scan) are left alone. On this
  repo's own database the first pruned scan removed 190 stale mappings
  (854 → 668), including all seven phantom `shutdown` ↔ markdown-heading
  links and the `main` ↔ Maintenance link.
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
- `doc-relay ack --doc <id> | --all` (CLI) and the `docrelay_ack` MCP tool:
  acknowledge stale doc sections as accurate after manual review, setting
  their status back to `in_sync`. Sections staled by a linked symbol change
  they never quoted (loose auto-links, prose mentions) previously had NO
  resolution path — `sync` deliberately leaves them stale and `confirm`
  only records mapping review status — so `check --strict` (pre-commit,
  pre-push, CI) failed forever. The sync "left stale" warning and the
  check markdown report now point at the command.
- Ghost doc-section pruning: scans now delete `standalone` doc_sections
  rows whose anchors vanished from a successfully parsed doc file
  (renamed/deleted headings) or whose file was deleted from disk while
  still under a configured `doc_dirs` path. Rows only ever accumulated:
  ghosts blocked `check --strict` permanently once staled, because sync
  can neither locate nor hash-match a vanished anchor. Mappings cascade
  via the foreign key; the deliberately FK-free review_history preserves
  the audit trail. Files that fail to parse, are `.docrelayignore`d, or
  sit outside the configured doc_dirs are never pruned (transient-error
  safety), and neither are `inline`/`generated` rows.
- Mapping evidence scores (schema v6): every auto-created mapping now
  stores the confidence it was linked with (0.4 prose mention … 1.0 exact
  heading match), refreshed on every scan as doc content evolves. Manual
  and legacy mappings default to 1.0 (unchanged behavior) until the next
  auto-link evaluation records their true score.
- Benchmark harness: `scripts/bench.mjs` builds a synthetic repo
  (configurable file/doc counts, 4000 symbols / 500+ sections by default)
  and times init, full/incremental scans, status, check, and review —
  used to drive the incremental-scan work below.
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
  branches (818 new tests, 1115 total):
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
- Signature-change staleness now cascades only through `confirmed`
  mappings or auto mappings with confidence ≥ 0.7 (backtick/codeblock/
  heading evidence — the doc actually quotes the symbol). Previously ANY
  non-rejected mapping propagated, so a single common-word symbol
  (`section`, `shutdown`, …) auto-linked by weak prose evidence could
  stale dozens of unrelated sections on every edit and permanently block
  `check --strict`. On this repo's own database the gate cuts the cascade
  surface from 831 mappings to 78. The file-watcher's deletion path
  applies the same gate (and no longer stales docs through `rejected`
  mappings at all).
- `link create` now records manual mappings as `confirmed` instead of
  `auto`: a link the user typed is asserted evidence, so the prune pass
  (which only re-evaluates `auto` rows) and the cascade confidence gate
  both treat it as deliberate. Upgrade note: mappings created by `link
  create` before this change are still stored as `auto` and will be
  re-scored — and deleted if the evidence does not support them — by the
  next scan; re-run the same `link create` (an idempotent upsert) to
  stamp them `confirmed`.
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

### Performance
- Auto-link candidate prefilter (inverted 4-gram index). Both pair loops
  scored every symbol × section pair; now a per-section index (exact ref
  text map, shared-4-gram map over normalized headings and heading-refs,
  short-haystack bucket, file-stem map) reduces scoring to only the
  sections that could possibly match. The filter is a proven superset of
  every matchable pair — each match rule (exact ref equality,
  word-boundary/substring headings, fuzzy matches, the stem-boosted 0.4
  rules) implies one of the indexed evidences — verified by randomized
  property tests over both passes at multiple minConfidence values and by
  a byte-identical mappings dump (4025 symbols / 4550 sections / 4500
  mappings) against the previous implementation. Measured with
  `scripts/bench.mjs`: init + full scan 1714ms → 902ms (1.9×; 7.7s at the
  start of the 0.3.1 perf campaign — 8.5× cumulative).
- Incremental scans skip unchanged documentation work. `scan
  --incremental` now delta-filters doc ingest by file mtime (same 1s
  filesystem-granularity tolerance as the extractor cutoff) and
  auto-links only the pairs that can produce something new —
  changed-symbols × all-sections, then all-symbols × changed-sections —
  so a no-change incremental scan does zero O(N×M) matching. Measured
  with `scripts/bench.mjs` (4000 symbols / 550 sections): no-op
  incremental 3839ms → 182ms (21×), 5%-changed incremental 3997ms →
  390ms (10×). The end state is identical to a full scan; the docs
  pipeline is shared between `init` and `scan` as `runDocsPipeline` in
  `src/cli-support.ts`.
- Doc-section ingest hoists its `SELECT` statement prepares out of the
  per-section loop — better-sqlite3 compiles SQL on every `prepare()`
  call, so preparing inside the loop measurably dominated ingest time
  on doc-heavy projects.
- `review`'s implied-reference scan precompiles its per-symbol
  word-boundary regexes once instead of inside the O(symbols ×
  sections) loop — it previously compiled (and re-escaped) an identical
  RegExp for every pair. Measured at the same bench scale: review
  1094ms → 446ms (2.5×).
- `sync --all-stale` on codegraph-less machines is ~3× faster: the batch
  path now probes codegraph availability ONCE instead of paying a failed
  spawn + preflight probes per symbol before the regex fallback (1800
  wasted process spawns on an 1800-stale project — 44% of sync time),
  and signature extraction reuses per-run comment-stripped source lines
  instead of re-reading, re-stripping, and re-splitting each file once
  per symbol it contains. Sync outcomes verified identical to the
  previous implementation on an 1800-stale corpus; the `which` probes
  no longer leak the child's stderr on lookup failure. Measured:
  8.4s → 3.0s (system time 4.05s → 0.15s).
- CLI startup is ~25% faster: the entry shim enables the V8 compile
  cache before loading the module graph (`module.enableCompileCache()`,
  floor Node 22.12 covers it), so bytecode is reused across process
  runs — measured 123-133ms → 91-103ms on `--version`, and it applies
  to every command including the per-commit git-hook invocations. The
  sync engine and the diff/history/gc/backup tool modules also moved
  behind per-command dynamic imports (matching the existing
  watch/review/mcp pattern), so the static graph only carries what the
  hot commands need.
- DB layer: hot helpers (`upsertSymbol`, `upsertDocSection`,
  `createMapping`, the ingest existence pre-check) now share a per-database
  prepared-statement cache (`src/db/statements.ts`) instead of recompiling
  the same SQL on every call — better-sqlite3 compiles on each `prepare()`,
  and a full scan runs these helpers thousands of times. Fuzzy auto-link
  matching also skips its O(n·m) longest-common-substring DP whenever a
  proven character-overlap upper bound shows the pair cannot reach the
  threshold (exact semantics preserved). Measured: init + full scan
  2668ms → 1772ms at bench scale; end state verified byte-identical to
  the previous implementation on the differential corpus.
- Full scans (init, `scan`, `docrelay_scan`) link ~3× faster: autoLink
  now precomputes per-symbol and per-section scoring profiles (cleaned
  names, word-boundary regexes, normalized strings, file stems, cleaned
  codeRefs) once per call instead of inside the O(symbols × sections)
  pair loop — every pair previously re-ran escapeRegex, compiled fresh
  RegExp objects, and re-normalized both strings. Measured:
  init + full scan 7707ms → 2668ms at bench scale; linking output
  verified byte-identical to the previous implementation on a 1600-symbol
  differential corpus.
- The incremental docs pipeline now covers every scan surface, not just
  the CLI: `docrelay_refresh` with `full=true` delta-filters doc ingest
  and auto-link against the previous scan watermark (agents polling
  periodically no longer pay O(symbols × sections) on every call), and
  the file watcher's debounced code/doc events use the same delta
  instead of re-ingesting and re-linking the entire project on every
  file change. Doc-only watch events deliberately do NOT move the
  `last_scan_at` watermark — it belongs to the symbol scan, and
  touching it would let the next incremental symbol scan skip code
  files edited since the real scan. The watermark read behind all
  three surfaces is the new shared `readLastScanAt()` helper.

### Fixed
- Standalone `auto_update` sync only rewrote docs that quoted the full raw
  declaration (`export function login(user: string): boolean {`). Docs
  written in the natural bare form (`login(user: string): boolean`) matched
  no candidate, so the section stayed stale forever — silently. Replacement
  candidates now include the derived bare form (declaration prefix cut at
  the symbol name, rejected when the prefix is not modifier-like) for both
  changelog and `raw_signature` sources, and the brace-stripped variant also
  covers Python's trailing colon.
- `sync --all-stale` processed every symbol mapped to a stale doc, including
  symbols whose signature never changed: each emitted a spurious "requires
  manual/agent rewrite" error AND marked its mapped sections stale, dragging
  previously in_sync sections into the stale set on every run. Symbols with
  a live signature and no recorded signature difference are now skipped
  silently; the rewrite error (which now includes the underlying reason)
  only fires when the current signature cannot be read at all, e.g. the
  symbol was deleted. Conversely, when a recorded signature change genuinely
  cannot be located in a stale section, sync now says so in a warning
  instead of failing silently.
- The codegraph MCP server was spawned without a working directory, so it
  resolved its `.codegraph/` index from docrelay's own cwd. Running a scan
  from inside a different indexed project (IDE/MCP hosts, or
  `DOCRELAY_PROJECT_ROOT` pointing elsewhere) silently ingested THAT
  project's symbols into the database — after which `gc` marked every real
  symbol stale and deleted it on the next pass. The server is now spawned
  rooted at the docrelay project root.
- `gc`, the watcher's incremental scan, and the MCP `docrelay_scan` /
  `docrelay_refresh` tools called the raw scanner without the builtin
  fallback the `scan` command has: with a codegraph binary present but no
  usable project index, scans returned 0 symbols — for `gc` a data-loss path
  that stales (then deletes) every symbol. All three surfaces now share
  `scanWithFallback` with the CLI scan.
- MCP scan responses leaked the internal `scannedIds` working set: a
  full `docrelay_scan` returned one hash per project symbol (a ~160 KB
  JSON array on a 4000-symbol project) inside `symbols.scannedIds`.
  Both `docrelay_scan` and `docrelay_refresh` now strip it, matching
  the CLI.
- `init` never ingested documentation: it scanned code symbols only, so
  doc sections and symbol↔doc mappings did not exist until the first
  explicit `scan`. Init now runs the full docs pipeline and reports
  "Scanned docs: N sections, M auto-linked" in its summary.
- Re-ingesting an unchanged doc inflated the `newMappings` metric and
  churned the WAL: the ingest code-reference linker went through
  `createMapping`'s UPSERT, whose ON CONFLICT clause rewrote (and
  counted as new) existing rows. It now existence-checks first and
  skips true duplicates.
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
- The codegraph server's stderr is no longer inherited by docrelay's own
  stderr: on projects without a `.codegraph/` index the server prints a
  status line on EVERY scan, which looked like a docrelay error. stderr is
  now piped into a 20-line tail buffer — surfaced only when the connection
  fails (where it explains why), echoed under `DOCRELAY_DEBUG=1`, and used
  to replace the misleading "explore parsing produced no results — output
  format may have changed" warning with the actual cause ("the project has
  no .codegraph/ index — run `codegraph init`"). The builtin-extractor
  fallback warning now carries the standard `DocRelay: ` prefix.
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
- A configured single doc FILE (e.g. `README.md` in `doc_dirs`) that failed
  to parse was reported nowhere — directory-walk failures were listed but
  single-file failures vanished silently. They now appear in `failedFiles`
  like any other parse failure (unsupported extensions stay silently
  skipped, matching walk behavior).
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
