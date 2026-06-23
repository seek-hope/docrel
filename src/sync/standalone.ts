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

import { validatePath, escapeRegex } from '../utils/fs.js';

/**
 * Open and validate a file for read/write within projectRoot.
 * Opens a real file descriptor for TOCTOU-safe operations — checks
 * properties on the fd, then reads through it.
 */
function openAndValidate(resolved: string, projectRoot: string): { content: string } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) {
      fs.closeSync(fd);
      return null;
    }
    // Re-validate real path via /proc/self/fd or fs.realpathSync
    const real = fs.realpathSync(resolved);
    const root = path.resolve(projectRoot);
    if (!real.startsWith(root + path.sep) && real !== root) {
      fs.closeSync(fd);
      return null;
    }
    const content = fs.readFileSync(fd, 'utf-8');
    return { content };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function updateStandaloneDoc(input: StandaloneSyncInput, projectRoot: string): boolean {
  const resolved = validatePath(input.file, projectRoot);
  if (!resolved) return false;
  if (!fs.existsSync(resolved)) return false;

  const validated = openAndValidate(resolved, projectRoot);
  if (!validated) return false;

  let content = validated.content;

  // Guard against empty oldContent — String.includes('') always returns true
  if (!input.oldContent || !input.newContent) return false;

  // Find the section by anchor (heading) using line-by-line parsing.
  // Pass the already-read content to avoid a TOCTOU race from a second disk read.
  const sectionContent = findSectionContentFromString(content, input.anchor);
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

  // Containment check: ensure resolved path is within project root
  if (projectRoot) {
    const root = path.resolve(projectRoot);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(root + path.sep) && real !== root) return null;
    } catch (err: any) {
      // Only swallow ENOENT / ENOTDIR (file may not exist yet).
      // Surface real errors like EACCES, EIO, ENAMETOOLONG.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
  }

  if (!fs.existsSync(resolved)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;

  const content = fs.readFileSync(resolved, 'utf-8');
  return findSectionContentFromString(content, anchor);
}

/**
 * Extract a markdown section from an already-read content string.
 * Avoids a second disk read (TOCTOU-safe when the caller already read the file).
 */
export function findSectionContentFromString(content: string, anchor: string): string | null {
  if (!anchor) return null;

  const lines = content.split('\n');
  let startLine = -1;
  let startLevel = 0;

  const escapedAnchor = escapeRegex(anchor);
  // Require exact heading match — nothing after the anchor text except optional trailing whitespace
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(new RegExp(`^(#{1,6})\\s+${escapedAnchor}\\s*$`));
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
