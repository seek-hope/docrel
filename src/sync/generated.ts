// src/sync/generated.ts
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GeneratedSyncInput {
  file: string;
  generator: string;  // e.g. "typedoc", "openapi-generator", "tsx scripts/generate-docs.ts"
  projectRoot: string;
}

export function updateGeneratedDoc(input: GeneratedSyncInput): { success: boolean; output: string } {
  try {
    const output = execSync(input.generator, {
      cwd: input.projectRoot,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: err.stderr ?? err.message };
  }
}

export function detectGenerator(file: string, projectRoot: string): string | null {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const scripts = pkg.scripts ?? {};

  if (file.endsWith('.yaml') || file.endsWith('.yml') || file.includes('openapi')) {
    return scripts['generate:api'] ?? scripts['generate:openapi'] ?? null;
  }

  if (file.includes('typedoc') || (file.endsWith('.md') && scripts['docs:generate'])) {
    return scripts['docs:generate'] ?? null;
  }

  return null;
}
