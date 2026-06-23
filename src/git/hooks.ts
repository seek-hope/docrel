import { simpleGit } from 'simple-git';
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
      if (err?.message && !/unknown revision|ambiguous argument/i.test(err.message)) {
        console.error(`DocRel post-commit: cannot check parent commit: ${err.message}`);
        return;
      }
    }

    if (!hasParent) return;

    const diff = await git.diff([`${log.latest.hash}^`, log.latest.hash]);
    if (!diff) return;

    // Re-scan affected symbols and mark docs as stale where needed
    await scanProject(codegraph, db, config);
  } catch (err: any) {
    console.error(`DocRel post-commit hook failed: ${err.message}`);
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
  // Resolve the real git directory (handles worktrees where .git is a file)
  const gitPath = path.join(projectRoot, '.git');
  let gitDir = gitPath;

  if (fs.existsSync(gitPath) && !fs.statSync(gitPath).isDirectory()) {
    try {
      const content = fs.readFileSync(gitPath, 'utf-8');
      const match = content.match(/gitdir:\s*(.+)/);
      if (match?.[1]) {
        gitDir = path.resolve(projectRoot, match[1].trim());
      }
    } catch { /* fall through to using .git path */ }
  }

  const hooksDir = path.join(gitDir, 'hooks');
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (err: any) {
    throw new Error(`Failed to create hooks directory ${hooksDir}: ${err.message}`);
  }

  // Resolve docrel binary path — use process.execPath as fallback when
  // process.argv[1] is undefined (e.g., bundled binary, MCP server, node -e).
  const argv1 = process.argv[1];
  let docrelBin: string;
  if (!argv1 || argv1 === 'undefined') {
    docrelBin = process.execPath;
  } else {
    docrelBin = path.resolve(argv1);
  }
  // Validate that the resolved binary exists and is executable
  if (!fs.existsSync(docrelBin)) {
    throw new Error(`DocRel binary not found at resolved path: ${docrelBin}. Install docrel globally or use --no-hooks.`);
  }

  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const postCommitPath = path.join(hooksDir, 'post-commit');
  const prePushPath = path.join(hooksDir, 'pre-push');

  // Quote binary path to handle spaces and special characters safely
  const preCommitScript = `#!/bin/sh
# DocRel pre-commit hook
"${docrelBin}" check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocRel: Documentation is stale. Run 'docrel sync' or use --no-verify to skip."
  exit 1
fi
`;

  const postCommitScript = `#!/bin/sh
# DocRel post-commit hook
git diff --name-only HEAD~1..HEAD 2>/dev/null | xargs -r "${docrelBin}" impact --
`;

  const prePushScript = `#!/bin/sh
# DocRel pre-push hook
"${docrelBin}" check --strict
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
