import { simpleGit } from 'simple-git';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { SymbolExtractor } from '../extractors/interface.js';
import type { DocSyncConfig } from '../utils/config.js';
import { docsyncCheck } from '../tools/check.js';
import { scanProject } from '../discovery/scanner.js';
import fs from 'node:fs';
import path from 'node:path';

export async function preCommitHook(
  projectRoot: string,
  db: Database.Database,
  extractor: SymbolExtractor,
  config: DocSyncConfig,
): Promise<{ allowed: boolean; message: string }> {
  try {
    const git = simpleGit(projectRoot);
    const status = await git.status();
    // Only staged files matter for pre-commit — do NOT include
    // created (untracked) files which would cause false positives.
    const staged = status.staged;

    if (staged.length === 0) {
      return { allowed: true, message: 'No staged files.' };
    }

    const report = docsyncCheck(db, true);

    // If the database query failed, report.error is set — treat as hard
    // failure to prevent silently allowing commits with unverified docs.
    if (report.error) {
      return { allowed: false, message: `DocSync: database query failed — documentation health cannot be verified. ${report.error}` };
    }

    // Check if any staged files correspond to stale docs
    const staleFiles = new Set(report.staleDocs.map((d) => d.file));
    const conflictFiles = staged.filter((f) => staleFiles.has(f));

    if (conflictFiles.length > 0) {
      return {
        allowed: false,
        message: `DocSync: ${conflictFiles.length} staged file(s) have stale documentation:\n${conflictFiles.map((f) => `  - ${f}`).join('\n')}\n\nRun 'docsync sync' to update them, or use --no-verify to skip.`,
      };
    }

    return { allowed: true, message: 'DocSync: all docs in sync.' };
  } catch (err: any) {
    // Distinguish transient SQLITE_BUSY from permanent failures.
    // If the database is locked by another process (e.g., concurrent scan),
    // blocking the commit would be a denial-of-service. Allow commits on BUSY
    // with a prominent warning so the developer can check manually.
    const isBusy = (err as any)?.code === 'SQLITE_BUSY' ||
      (typeof (err as any)?.message === 'string' && /\bdatabase.*locked\b/i.test((err as any).message));
    if (isBusy) {
      console.warn('DocSync: database locked — skipping pre-commit check. Run `docsync check` manually to verify documentation.');
      return { allowed: true, message: 'DocSync: database locked — pre-commit check skipped. Run `docsync check` manually.' };
    }
    console.error(`DocSync pre-commit hook error:`, err);
    return { allowed: false, message: 'DocSync: pre-commit check failed: internal error — check docsync logs for details.' };
  }
}

export async function postCommitHook(
  projectRoot: string,
  db: Database.Database,
  extractor: SymbolExtractor,
  config: DocSyncConfig,
): Promise<void> {
  try {
    const git = simpleGit(projectRoot);

    // Get the diff of the last commit
    const log = await git.log({ maxCount: 1 });
    if (!log.latest) return;

    // Check if the commit has a parent (fails on first commit).
    // Differentiate 'unknown revision' (no parent) from real errors (e.g. corrupt repo, I/O error).
    let hasParent = false;
    try {
      await git.raw(['rev-parse', `${log.latest.hash}^`]);
      hasParent = true;
    } catch (err: any) {
      // Only ignore 'unknown revision or path' — surface real errors
      if (!err?.message) {
        console.error('DocSync post-commit: unexpected error checking parent commit:', err);
        return;
      }
      if (!/unknown revision|ambiguous argument/i.test(err.message)) {
        console.error(`DocSync post-commit: cannot check parent commit: ${err.message}`);
        return;
      }
    }

    if (!hasParent) return;

    // Always re-scan after a commit, even when git reports an empty diff
    // (merge commits, empty commits, or amended commits can leave docs stale).
    // We fetch the diff to verify git connectivity but always do a full re-scan.
    void await git.diff([`${log.latest.hash}^`, log.latest.hash]);

    // Re-scan affected symbols and mark docs as stale where needed
    await scanProject(extractor, db, config, projectRoot, false /* incremental */);
  } catch (err: any) {
    // Log a prominent warning with actionable next steps. If the scan fails
    // (e.g., codegraph not running), the commit succeeds but docs are not
    // updated. Write a marker file that docsync status can detect so the user
    // is not silently left with potentially stale documentation.
    console.error(`DocSync post-commit hook failed: ${err.message}`);
    console.warn('DocSync: Post-commit scan failed — your documentation may be stale. Run `docsync status` to check.');
    try {
      const markerDir = path.join(projectRoot, '.docsync');
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(path.join(markerDir, 'post-commit-failed'), Date.now().toString());
    } catch { /* best-effort marker */ }
  }
}

export function prepareCommitMsg(db: Database.Database): string {
  const pendingChanges = (db.prepare(
    "SELECT COUNT(*) as c FROM changelog WHERE sync_status = 'pending'"
  ).get() as { c: number }).c;

  const syncedDocs = (db.prepare(
    "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'in_sync'"
  ).get() as { c: number }).c;

  const flaggedForReview = (db.prepare(
    "SELECT COUNT(*) as c FROM doc_sections WHERE status = 'stale'"
  ).get() as { c: number }).c;

  return `DocSync: ${pendingChanges} symbols changed, ${syncedDocs} docs synced, ${flaggedForReview} docs flagged for review`;
}

export async function prePushHook(
  projectRoot: string,
  db: Database.Database,
): Promise<{ allowed: boolean; message: string }> {
  try {
    const report = docsyncCheck(db, true);

    // If the database query failed, treat as hard failure
    if (report.error) {
      return { allowed: false, message: `DocSync: database query failed — documentation health cannot be verified. ${report.error}` };
    }

    if (!report.passed) {
      return {
        allowed: false,
        message: `DocSync: Cannot push — ${report.staleDocs.length} doc section(s) are stale.\n\nRun 'docsync check' for details.`,
      };
    }

    return { allowed: true, message: 'DocSync: all docs in sync.' };
  } catch (err: any) {
    console.error(`DocSync pre-push hook error:`, err);
    return { allowed: false, message: 'DocSync: pre-push check failed: internal error — check docsync logs for details.' };
  }
}

export function installHooks(projectRoot: string, force = false): void {
  // Resolve the real git directory (handles worktrees where .git is a file).
  // In a worktree, .git is a file containing 'gitdir: <path>' pointing to
  // the main repo's .git/worktrees/<name>. We need the MAIN .git directory
  // for hooks (shared across worktrees), not the worktree-specific one.
  const gitPath = path.join(projectRoot, '.git');
  let gitDir = gitPath;

  let isWorktreeGit = false;
  let gitFd: number | undefined;
  try {
    gitFd = fs.openSync(gitPath, 'r');
    const fst = fs.fstatSync(gitFd);
    isWorktreeGit = !fst.isDirectory();
  } catch { /* stat failed — treat as not a worktree */ }
  if (isWorktreeGit) {
    try {
      const content = fs.readFileSync(gitFd!, 'utf-8');
      const match = content.match(/gitdir:\s*(.+)/);
      if (match?.[1]) {
        const rawGitdir = match[1].trim();
        const resolvedGitdir = path.resolve(projectRoot, rawGitdir);
        const root = path.resolve(projectRoot);
        // Worktree gitdir resolves outside the worktree root (e.g. to
        // /main-repo/.git/worktrees/feature). Derive the main .git directory
        // by stripping the .git/worktrees/<name> suffix, matching the
        // pattern used in src/db/connection.ts lines 52-58.
        if (!resolvedGitdir.startsWith(root + path.sep) && resolvedGitdir !== root) {
          const worktreesIdx = resolvedGitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
          if (worktreesIdx > 0) {
            gitDir = resolvedGitdir.slice(0, worktreesIdx) + path.sep + '.git';
          }
        } else {
          gitDir = resolvedGitdir;
        }
      }
    } catch { /* fall through to using .git path */ }
  }
  if (gitFd !== undefined) {
    try { fs.closeSync(gitFd); } catch { /* best effort */ }
  }

  // Safety: if gitDir is still a file (not a directory), mkdirSync below
  // would throw ENOTDIR. Fall back to .docsync/hooks/ in the project root.
  try {
    if (fs.existsSync(gitDir) && !fs.statSync(gitDir).isDirectory()) {
      gitDir = path.join(projectRoot, '.docsync');
    }
  } catch { gitDir = path.join(projectRoot, '.docsync'); }

  const hooksDir = path.join(gitDir, 'hooks');
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (err: any) {
    throw new Error(`Failed to create hooks directory ${hooksDir}: ${err.message}`);
  }

  // Resolve docsync binary path. When process.argv[1] is undefined (e.g., MCP
  // server mode, bundled binary, node -e), search PATH for 'docsync' instead of
  // falling back to process.execPath (Node.js runtime) which would not run docsync.
  const argv1 = process.argv[1];
  let docsyncBin: string;
  if (!argv1 || argv1 === 'undefined') {
    try {
      docsyncBin = execFileSync('which', ['docsync'], { encoding: 'utf-8' }).trim();
      if (!docsyncBin) throw new Error('docsync not found on PATH');
      // Validate the resolved binary path against allowed prefixes and resolve
      // symlinks to prevent PATH hijacking via malicious symlinks.
      const realBin = fs.realpathSync(docsyncBin);
      const allowedPrefixes = ['/usr/', '/opt/', '/home/', '/run/current-system/'];
      if (!allowedPrefixes.some((p) => realBin.startsWith(p))) {
        throw new Error(`docsync resolved to unexpected path: ${docsyncBin}`);
      }
      docsyncBin = realBin;
      // Verify the resolved binary immediately to close the TOCTOU window
      // between which/realpathSync and use.
      try {
        execFileSync(docsyncBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
      } catch (verr: any) {
        throw new Error(`docsync binary at ${docsyncBin} does not appear to work: ${verr.message}`);
      }
    } catch (err: any) {
      throw new Error(`Cannot locate docsync binary: ${err.message}. Install docsync globally or use --no-hooks.`);
    }
  } else {
    // When argv1 is defined (CLI mode), apply the same validation pipeline
    // used in the PATH-search path above: resolve symlinks, check against
    // allowed prefixes. An attacker who can influence argv[1] (e.g., via a
    // crafted shebang, symlink, or PATH manipulation) could otherwise install
    // hooks that execute an arbitrary binary from an unexpected location.
    const resolvedArgv = path.resolve(argv1);
    try {
      const realBin = fs.realpathSync(resolvedArgv);
      const allowedPrefixes = ['/usr/', '/opt/', '/home/', '/run/current-system/'];
      if (!allowedPrefixes.some((p) => realBin.startsWith(p))) {
        throw new Error(`docsync resolved to unexpected path: ${resolvedArgv}`);
      }
      docsyncBin = realBin;
    } catch (err: any) {
      throw new Error(`Cannot locate docsync binary: ${err.message}. Install docsync globally or use --no-hooks.`);
    }
  }

  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const postCommitPath = path.join(hooksDir, 'post-commit');
  const prePushPath = path.join(hooksDir, 'pre-push');
  const prepareCommitMsgPath = path.join(hooksDir, 'prepare-commit-msg');

  // Validate that the resolved binary is actually a working docsync installation.
  // A bundled or corrupted binary may not support the expected CLI interface,
  // causing confusing shell errors at git operation time instead of here.
  try {
    execFileSync(docsyncBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
  } catch (err: any) {
    throw new Error(`Resolved docsync binary at ${docsyncBin} does not appear to work: ${err.message}`);
  }

  // Re-verify the binary just before shell quoting to close the TOCTOU window
  // between initial verification and use. A concurrent binary swap (extremely
  // unlikely, requires nanosecond-precision timing and write access) could
  // otherwise bypass the initial check.
  try {
    execFileSync(docsyncBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
  } catch (err: any) {
    throw new Error(`Re-verification of docsync binary at ${docsyncBin} failed: ${err.message}`);
  }

  // Properly escape the binary path for single-quoted shell context using the
  // standard shell quoting trick: replace every ' with '\''.
  // This handles ALL possible filename characters including single quotes,
  // which are valid on Linux filesystems (ext4, xfs, btrfs).
  function shellQuote(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
  const docsyncQuoted = shellQuote(docsyncBin);

  const preCommitScript = `#!/bin/sh
# DocSync pre-commit hook
set -e
${docsyncQuoted} check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocSync: Documentation is stale. Run 'docsync sync' or use --no-verify to skip."
  exit 1
fi
`;

  const postCommitScript = `#!/bin/sh
# DocSync post-commit hook
set -e
git diff --name-only -z HEAD~1..HEAD 2>/dev/null | xargs -0 -r ${docsyncQuoted} impact --
`;

  const prePushScript = `#!/bin/sh
# DocSync pre-push hook
set -e
${docsyncQuoted} check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocSync: Cannot push with stale documentation."
  exit 1
fi
`;

  const prepareCommitMsgScript = `#!/bin/sh
# DocSync prepare-commit-msg hook
${docsyncQuoted} annotate-commit "$1"
`;

  const hooks = [
    { path: preCommitPath, script: preCommitScript, name: 'pre-commit' },
    { path: postCommitPath, script: postCommitScript, name: 'post-commit' },
    { path: prePushPath, script: prePushScript, name: 'pre-push' },
    { path: prepareCommitMsgPath, script: prepareCommitMsgScript, name: 'prepare-commit-msg' },
  ];

  // Install with rollback on partial failure
  const installed: string[] = [];
  try {
    for (const hook of hooks) {
      if (fs.existsSync(hook.path) && !force) {
        console.warn(`DocSync: ${hook.name} hook already exists — skipping (use --force to override)`);
        continue;
      }
      fs.writeFileSync(hook.path, hook.script, { mode: 0o755 });
      installed.push(hook.path);
    }
  } catch (err: any) {
    // Rollback: remove successfully installed hooks on failure
    for (const p of installed) {
      try { fs.unlinkSync(p); } catch { /* best effort */ }
    }
    throw new Error(`Failed to install hooks: ${err.message}. Removed ${installed.length} partially installed hooks.`);
  }

  console.log(`DocSync hooks installed in ${hooksDir}/`);
}
