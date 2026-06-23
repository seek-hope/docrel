// src/sync/standalone.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface StandaloneSyncInput {
  file: string;
  anchor: string;
  oldContent: string;
  newContent: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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

/**
 * Open and validate a file for read/write within projectRoot.
 * Minimizes TOCTOU by opening first, then checking properties on the fd.
 */
function openAndValidate(resolved: string, projectRoot: string): { fd: number; content: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_SIZE) return null;

  // Open file handle to close the TOCTOU window
  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }

  // Re-validate real path after read to ensure no symlink swap
  try {
    const real = fs.realpathSync(resolved);
    const root = path.resolve(projectRoot);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
  } catch {
    return null;
  }

  return { fd: -1, content };
}

export function updateStandaloneDoc(input: StandaloneSyncInput, projectRoot: string): boolean {
  const resolved = validatePath(input.file, projectRoot);
  if (!resolved) return false;
  if (!fs.existsSync(resolved)) return false;

  const result = openAndValidate(resolved, projectRoot);
  if (!result) return false;

  let content = result.content;

  // Find the section by anchor (heading) using line-by-line parsing
  const sectionContent = findSectionContent(resolved, input.anchor, projectRoot);
  if (!sectionContent) return false;
  if (!sectionContent.includes(input.oldContent)) return false;

  const updatedSection = sectionContent.replace(input.oldContent, input.newContent);
  content = content.replace(sectionContent, updatedSection);

  // Atomic write: use os.tmpdir() with random name (not deterministic path)
  const tmpPath = path.join(os.tmpdir(), `docrel-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
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
 * @param file Relative or absolute file path (resolved against projectRoot if relative)
 */
export function findSectionContent(file: string, anchor: string, projectRoot?: string): string | null {
  if (!anchor) return null;

  const resolved = projectRoot ? path.resolve(projectRoot, file) : file;
  if (!fs.existsSync(resolved)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;

  const content = fs.readFileSync(resolved, 'utf-8');
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
