import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


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

  return `DocRelay: ${pendingChanges} symbols changed, ${syncedDocs} docs synced, ${flaggedForReview} docs flagged for review`;
}


/**
 * Resolve the real git directory (handles worktrees where .git is a file).
 * In a worktree, .git is a file containing 'gitdir: <path>' pointing to
 * the main repo's .git/worktrees/<name>. We need the MAIN .git directory
 * for hooks (shared across worktrees), not the worktree-specific one.
 * Falls back to `<projectRoot>/.docrelay` when no usable git dir exists.
 */
export function resolveGitDir(projectRoot: string): string {
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
  // would throw ENOTDIR. Fall back to .docrelay/hooks/ in the project root.
  try {
    if (fs.existsSync(gitDir) && !fs.statSync(gitDir).isDirectory()) {
      gitDir = path.join(projectRoot, '.docrelay');
    }
  } catch { gitDir = path.join(projectRoot, '.docrelay'); }

  return gitDir;
}

export function installHooks(projectRoot: string, force = false): void {
  const hooksDir = path.join(resolveGitDir(projectRoot), 'hooks');
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (err: any) {
    throw new Error(`Failed to create hooks directory ${hooksDir}: ${err.message}`, { cause: err });
  }

  // Resolve docrelay binary path. When process.argv[1] is undefined (e.g., MCP
  // server mode, bundled binary, node -e), search PATH for 'docrelay' instead of
  // falling back to process.execPath (Node.js runtime) which would not run docrelay.
  const argv1 = process.argv[1];
  let docrelayBin: string;
  if (!argv1 || argv1 === 'undefined') {
    try {
      docrelayBin = execFileSync('which', ['docrelay'], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!docrelayBin) throw new Error('docrelay not found on PATH');
      // Validate the resolved binary path against allowed prefixes and resolve
      // symlinks to prevent PATH hijacking via malicious symlinks.
      const realBin = fs.realpathSync(docrelayBin);
      const allowedPrefixes = ['/usr/bin/', '/usr/local/bin/', '/usr/lib/node_modules/.bin/', '/opt/', '/run/current-system/sw/bin/'];
      if (!allowedPrefixes.some((p) => realBin.startsWith(p)) &&
          !/\/(\.local\/share|\.npm|\.nvm)\//.test(realBin)) {
        throw new Error(`docrelay resolved to unexpected path: ${docrelayBin}`);
      }
      docrelayBin = realBin;
      // Verify the resolved binary immediately to close the TOCTOU window
      // between which/realpathSync and use.
      try {
        execFileSync(docrelayBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
      } catch (verr: any) {
        throw new Error(`docrelay binary at ${docrelayBin} does not appear to work: ${verr.message}`, { cause: verr });
      }
    } catch (err: any) {
      throw new Error(`Cannot locate docrelay binary: ${err.message}. Install docrelay globally or use --no-hooks.`, { cause: err });
    }
  } else {
    // When argv1 is defined (CLI mode), trust the binary if it is the
    // currently executing cli.js itself (self-reference): code that is
    // already running cannot gain anything by spoofing its own path. This
    // covers npm link / `npm install -g <local folder>` layouts where the
    // global bin symlinks back into a project checkout whose realpath is
    // NOT under any conventional install prefix. When the self-reference
    // cannot be established (bundled builds), fall back to the allowed
    // prefix validation against PATH-style installs.
    const resolvedArgv = path.resolve(argv1);
    try {
      const realBin = fs.realpathSync(resolvedArgv);
      let selfCli: string | null = null;
      try {
        // This module lives at <pkg>/dist/git/hooks.js; cli.js is one level up.
        selfCli = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js'));
      } catch { selfCli = null; }
      if (selfCli && realBin === selfCli) {
        docrelayBin = realBin;
      } else {
        const allowedPrefixes = ['/usr/bin/', '/usr/local/bin/', '/usr/lib/node_modules/.bin/', '/opt/', '/run/current-system/sw/bin/'];
        if (!allowedPrefixes.some((p) => realBin.startsWith(p)) &&
            !/\/(\.local\/share|\.npm|\.nvm)\//.test(realBin)) {
          throw new Error(`docrelay resolved to unexpected path: ${resolvedArgv}`);
        }
        docrelayBin = realBin;
      }
    } catch (err: any) {
      throw new Error(`Cannot locate docrelay binary: ${err.message}. Install docrelay globally or use --no-hooks.`, { cause: err });
    }
  }

  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const postCommitPath = path.join(hooksDir, 'post-commit');
  const prePushPath = path.join(hooksDir, 'pre-push');
  const prepareCommitMsgPath = path.join(hooksDir, 'prepare-commit-msg');

  // Validate that the resolved binary is actually a working docrelay installation.
  // A bundled or corrupted binary may not support the expected CLI interface,
  // causing confusing shell errors at git operation time instead of here.
  try {
    execFileSync(docrelayBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
  } catch (err: any) {
    throw new Error(`Resolved docrelay binary at ${docrelayBin} does not appear to work: ${err.message}`, { cause: err });
  }

  // Re-verify the binary just before shell quoting to close the TOCTOU window
  // between initial verification and use. A concurrent binary swap (extremely
  // unlikely, requires nanosecond-precision timing and write access) could
  // otherwise bypass the initial check.
  try {
    execFileSync(docrelayBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
  } catch (err: any) {
    throw new Error(`Re-verification of docrelay binary at ${docrelayBin} failed: ${err.message}`, { cause: err });
  }

  // Properly escape the binary path for single-quoted shell context using the
  // standard shell quoting trick: replace every ' with '\''.
  // This handles ALL possible filename characters including single quotes,
  // which are valid on Linux filesystems (ext4, xfs, btrfs).
  function shellQuote(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
  const docrelayQuoted = shellQuote(docrelayBin);


  // Fail-open guard snippet for every hook. DocRelay is uninitialized when
  // neither .docrelay/ nor .git/docrelay.db exists — e.g. fresh git worktrees
  // or pre-init clones. When so, warn and exit 0 so we never block git
  // operations (defect: hooks used to hard-fail with 'Not initialized').
  const failOpenGuard = `if [ ! -d ".docrelay" ] && [ ! -f ".git/docrelay.db" ]; then
  echo "DocRelay: project not initialized — skipping "$HOOK" check."
  echo "DocRelay: run 'docrelay init' to enable documentation checks."
  exit 0
fi
`;

  // Additional runtime guard: even when the above sentinel check passes, the
  // docrelay status command may still fail (e.g. corrupted/missing config or
  // DB). Treat any docrelay failure as fail-open for non-blocking hooks
  // (post-commit, prepare-commit-msg) and as a hard gate only where a strict
  // check is explicitly intended (pre-commit/pre-push).
  const infraGuidance = `echo ""
echo "DocRelay: documentation check could not run (infrastructure error — often a database locked by a concurrent watch/MCP process)."
echo "DocRelay: retry the command, or diagnose with 'doc-relay health'. Use --no-verify to bypass."
exit 1
`;
  const preCommitScript = `#!/bin/sh
# DocRelay pre-commit hook
HOOK=pre-commit
${failOpenGuard}${docrelayQuoted} check --strict
rc=$?
# Exit 2 = infrastructure error (locked/corrupt DB): not a staleness verdict.
if [ $rc -eq 2 ]; then
${infraGuidance}
fi
if [ $rc -ne 0 ]; then
  echo ""
  echo "DocRelay: Documentation is stale. Run 'doc-relay sync' to update docs, 'doc-relay ack' for sections that are already accurate, or use --no-verify to skip."
  exit 1
fi
`;

  const postCommitScript = `#!/bin/sh
# DocRelay post-commit hook
HOOK=post-commit
set -e
${failOpenGuard}# Incrementally re-scan so the post-commit DB state reflects the new code.
${docrelayQuoted} scan --incremental || { echo "DocRelay: post-commit scan failed — run 'docrelay status' to check."; exit 0; }
# Then surface the docs impacted by the changed files.
git diff --name-only -z HEAD~1..HEAD 2>/dev/null | xargs -0 -r ${docrelayQuoted} impact -- >/dev/null || true
exit 0
`;

  const prePushScript = `#!/bin/sh
# DocRelay pre-push hook
HOOK=pre-push
${failOpenGuard}${docrelayQuoted} check --strict
rc=$?
# Exit 2 = infrastructure error (locked/corrupt DB): not a staleness verdict.
if [ $rc -eq 2 ]; then
${infraGuidance}
fi
if [ $rc -ne 0 ]; then
  echo ""
  echo "DocRelay: Cannot push with stale documentation."
  exit 1
fi
`;

  const prepareCommitMsgScript = `#!/bin/sh
# DocRelay prepare-commit-msg hook
HOOK=prepare-commit-msg
${failOpenGuard}${docrelayQuoted} annotate-commit "$1" || true
exit 0
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
        console.warn(`DocRelay: ${hook.name} hook already exists — skipping (use --force to override)`);
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
    throw new Error(`Failed to install hooks: ${err.message}. Removed ${installed.length} partially installed hooks.`, { cause: err });
  }

  console.log(`DocRelay hooks installed in ${hooksDir}/`);
}
