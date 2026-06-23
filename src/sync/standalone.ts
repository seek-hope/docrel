// src/sync/standalone.ts
import fs from 'node:fs';
import path from 'node:path';

export interface StandaloneSyncInput {
  file: string;
  anchor: string;
  oldContent: string;
  newContent: string;
}

/** Resolve and validate that filePath is within projectRoot. Returns resolved path or null. */
function validatePath(filePath: string, projectRoot: string): string | null {
  const resolved = path.resolve(projectRoot, filePath);
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  // Resolve symlinks to ensure the real path is also within project root
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
  } catch {
    // File doesn't exist yet — trust the resolved path
  }
  return resolved;
}

export function updateStandaloneDoc(input: StandaloneSyncInput, projectRoot: string): boolean {
  const resolved = validatePath(input.file, projectRoot);
  if (!resolved) return false;
  if (!fs.existsSync(resolved)) return false;

  let content = fs.readFileSync(resolved, 'utf-8');

  // Find the section by anchor (heading) using line-by-line parsing
  const sectionContent = findSectionContent(resolved, input.anchor);
  if (!sectionContent) return false;
  if (!sectionContent.includes(input.oldContent)) return false;

  const updatedSection = sectionContent.replace(input.oldContent, input.newContent);
  content = content.replace(sectionContent, updatedSection);

  // Atomic write
  const tmpPath = resolved + '.docrel.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, resolved);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }

  return true;
}

/**
 * Find the content of a markdown section identified by anchor (heading text).
 * Uses line-by-line parsing to correctly handle # characters inside code blocks.
 */
export function findSectionContent(file: string, anchor: string): string | null {
  if (!anchor) return null;
  if (!fs.existsSync(file)) return null;

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  let startLine = -1;
  let startLevel = 0;

  const escapedAnchor = escapeRegex(anchor);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(new RegExp(`^(#{1,6})\\s+${escapedAnchor}\\b`));
    if (match) {
      startLine = i;
      startLevel = match[1].length;
      break;
    }
  }
  if (startLine < 0) return null;

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/);
    if (match && match[1].length <= startLevel) {
      endLine = i;
      break;
    }
  }

  return lines.slice(startLine, endLine).join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
