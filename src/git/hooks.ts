import { simpleGit } from 'simple-git';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { CodegraphClient } from '../codegraph/client.js';
import type { DocRelConfig } from '../utils/config.js';
import { docrelCheck } from '../tools/check.js';
import { scanProject } from '../discovery/scanner.js';
import fs from 'node:fs';
import path from 'node:path';

export async function preCommitHook(
  projectRoot: string,
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
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

    const report = docrelCheck(db, true);

    // Check if any staged files correspond to stale docs
    const staleFiles = new Set(report.staleDocs.map((d) => d.file));
    const conflictFiles = staged.filter((f) => staleFiles.has(f));

    if (conflictFiles.length > 0) {
      return {
        allowed: false,
        message: `DocRel: ${conflictFiles.length} staged file(s) have stale documentation:\n${conflictFiles.map((f) => `  - ${f}`).join('\n')}\n\nRun 'docrel sync' to update them, or use --no-verify to skip.`,
      };
    }

    return { allowed: true, message: 'DocRel: all docs in sync.' };
  } catch (err: any) {
    return { allowed: false, message: `DocRel: failed to run pre-commit check: ${err.message}` };
  }
}

export async function postCommitHook(
  projectRoot: string,
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
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
        console.error('DocRel post-commit: unexpected error checking parent commit:', err);
        return;
      }
      if (!/unknown revision|ambiguous argument/i.test(err.message)) {
        console.error(`DocRel post-commit: cannot check parent commit: ${err.message}`);
        return;
      }
    }

    if (!hasParent) return;

    // Always re-scan after a commit, even when git reports an empty diff
    // (merge commits, empty commits, or amended commits can leave docs stale).
    const diff = await git.diff([`${log.latest.hash}^`, log.latest.hash]);

    // Re-scan affected symbols and mark docs as stale where needed
    await scanProject(codegraph, db, config);
  } catch (err: any) {
    // Log a prominent warning with actionable next steps. If the scan fails
    // (e.g., codegraph not running), the commit succeeds but docs are not
    // updated. Write a marker file that docrel status can detect so the user
    // is not silently left with potentially stale documentation.
    console.error(`DocRel post-commit hook failed: ${err.message}`);
    console.warn('DocRel: Post-commit scan failed — your documentation may be stale. Run `docrel status` to check.');
    try {
      const markerDir = path.join(projectRoot, '.docrel');
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(path.join(markerDir, 'post-commit-failed'), Date.now().toString());
    } catch { /* best-effort marker */ }
  }
}

export async function prePushHook(
  projectRoot: string,
  db: Database.Database,
): Promise<{ allowed: boolean; message: string }> {
  try {
    const report = docrelCheck(db, true);

    if (!report.passed) {
      return {
        allowed: false,
        message: `DocRel: Cannot push — ${report.staleDocs.length} doc section(s) are stale.\n\nRun 'docrel check' for details.`,
      };
    }

    return { allowed: true, message: 'DocRel: all docs in sync.' };
  } catch (err: any) {
    return { allowed: false, message: `DocRel: pre-push check failed: ${err.message}` };
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
  try { isWorktreeGit = fs.existsSync(gitPath) && !fs.statSync(gitPath).isDirectory(); } catch { /* stat failed — treat as not a worktree */ }
  if (isWorktreeGit) {
    try {
      const content = fs.readFileSync(gitPath, 'utf-8');
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

  // Safety: if gitDir is still a file (not a directory), mkdirSync below
  // would throw ENOTDIR. Fall back to .docrel/hooks/ in the project root.
  try {
    if (fs.existsSync(gitDir) && !fs.statSync(gitDir).isDirectory()) {
      gitDir = path.join(projectRoot, '.docrel');
    }
  } catch { gitDir = path.join(projectRoot, '.docrel'); }

  const hooksDir = path.join(gitDir, 'hooks');
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (err: any) {
    throw new Error(`Failed to create hooks directory ${hooksDir}: ${err.message}`);
  }

  // Resolve docrel binary path. When process.argv[1] is undefined (e.g., MCP
  // server mode, bundled binary, node -e), search PATH for 'docrel' instead of
  // falling back to process.execPath (Node.js runtime) which would not run docrel.
  const argv1 = process.argv[1];
  let docrelBin: string;
  if (!argv1 || argv1 === 'undefined') {
    try {
      docrelBin = execFileSync('which', ['docrel'], { encoding: 'utf-8' }).trim();
      if (!docrelBin) throw new Error('docrel not found on PATH');
      // Validate the resolved binary path against allowed prefixes and resolve
      // symlinks to prevent PATH hijacking via malicious symlinks.
      const realBin = fs.realpathSync(docrelBin);
      const allowedPrefixes = ['/usr/', '/opt/', '/home/', '/run/current-system/'];
      if (!allowedPrefixes.some((p) => realBin.startsWith(p))) {
        throw new Error(`docrel resolved to unexpected path: ${docrelBin}`);
      }
      docrelBin = realBin;
    } catch (err: any) {
      throw new Error(`Cannot locate docrel binary: ${err.message}. Install docrel globally or use --no-hooks.`);
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
        throw new Error(`docrel resolved to unexpected path: ${resolvedArgv}`);
      }
      docrelBin = realBin;
    } catch (err: any) {
      throw new Error(`Cannot locate docrel binary: ${err.message}. Install docrel globally or use --no-hooks.`);
    }
  }

  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const postCommitPath = path.join(hooksDir, 'post-commit');
  const prePushPath = path.join(hooksDir, 'pre-push');

  // Validate that the resolved binary is actually a working docrel installation.
  // A bundled or corrupted binary may not support the expected CLI interface,
  // causing confusing shell errors at git operation time instead of here.
  try {
    execFileSync(docrelBin, ['--version'], { timeout: 5000, encoding: 'utf-8' });
  } catch (err: any) {
    throw new Error(`Resolved docrel binary at ${docrelBin} does not appear to work: ${err.message}`);
  }

  // Properly escape the binary path for single-quoted shell context using the
  // standard shell quoting trick: replace every ' with '\''.
  // This handles ALL possible filename characters including single quotes,
  // which are valid on Linux filesystems (ext4, xfs, btrfs).
  function shellQuote(str: string): string {
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }
  const docrelQuoted = shellQuote(docrelBin);

  const preCommitScript = `#!/bin/sh
# DocRel pre-commit hook
${docrelQuoted} check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocRel: Documentation is stale. Run 'docrel sync' or use --no-verify to skip."
  exit 1
fi
`;

  const postCommitScript = `#!/bin/sh
# DocRel post-commit hook
git diff --name-only -z HEAD~1..HEAD 2>/dev/null | xargs -0 -r ${docrelQuoted} impact --
`;

  const prePushScript = `#!/bin/sh
# DocRel pre-push hook
${docrelQuoted} check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocRel: Cannot push with stale documentation."
  exit 1
fi
`;

  const hooks = [
    { path: preCommitPath, script: preCommitScript, name: 'pre-commit' },
    { path: postCommitPath, script: postCommitScript, name: 'post-commit' },
    { path: prePushPath, script: prePushScript, name: 'pre-push' },
  ];

  // Install with rollback on partial failure
  const installed: string[] = [];
  try {
    for (const hook of hooks) {
      if (fs.existsSync(hook.path) && !force) {
        console.warn(`DocRel: ${hook.name} hook already exists — skipping (use --force to override)`);
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

  console.log(`DocRel hooks installed in ${hooksDir}/`);
}
