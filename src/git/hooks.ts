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
  const git = simpleGit(projectRoot);
  const status = await git.status();
  const staged = status.staged.concat(status.created);

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
}

export async function postCommitHook(
  projectRoot: string,
  db: Database.Database,
  codegraph: CodegraphClient,
  config: DocRelConfig,
): Promise<void> {
  const git = simpleGit(projectRoot);

  // Get the diff of the last commit
  const log = await git.log({ maxCount: 1 });
  if (!log.latest) return;

  const diff = await git.diff([`${log.latest.hash}^`, log.latest.hash]);
  if (!diff) return;

  // Re-scan affected symbols and mark docs as stale where needed
  await scanProject(codegraph, db, config);
}

export async function prePushHook(
  projectRoot: string,
  db: Database.Database,
): Promise<{ allowed: boolean; message: string }> {
  const report = docrelCheck(db, true);

  if (!report.passed) {
    return {
      allowed: false,
      message: `DocRel: Cannot push — ${report.staleDocs.length} doc section(s) are stale.\n\nRun 'docrel check' for details.`,
    };
  }

  return { allowed: true, message: 'DocRel: all docs in sync.' };
}

export function installHooks(projectRoot: string): void {
  const hooksDir = path.join(projectRoot, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const postCommitPath = path.join(hooksDir, 'post-commit');
  const prePushPath = path.join(hooksDir, 'pre-push');

  const preCommitScript = `#!/bin/sh
# DocRel pre-commit hook
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocRel: Documentation is stale. Run 'docrel sync' or use --no-verify to skip."
  exit 1
fi
`;

  const postCommitScript = `#!/bin/sh
# DocRel post-commit hook
docrel impact $(git diff --name-only HEAD~1..HEAD 2>/dev/null || echo "")
`;

  const prePushScript = `#!/bin/sh
# DocRel pre-push hook
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "DocRel: Cannot push with stale documentation."
  exit 1
fi
`;

  fs.writeFileSync(preCommitPath, preCommitScript, { mode: 0o755 });
  fs.writeFileSync(postCommitPath, postCommitScript, { mode: 0o755 });
  fs.writeFileSync(prePushPath, prePushScript, { mode: 0o755 });

  console.log('DocRel hooks installed in .git/hooks/');
}
