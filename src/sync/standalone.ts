// src/sync/standalone.ts
import fs from 'node:fs';
import path from 'node:path';
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
    // Re-validate real path using the actual open file descriptor instead of
    // the filesystem path. This eliminates the TOCTOU gap where an attacker
    // could swap a symlink between openSync and realpathSync.
    const real = fs.realpathSync(`/proc/self/fd/${fd}`);
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

export interface StandaloneUpdateResult {
  success: boolean;
  reason?: string;
}

export function updateStandaloneDoc(input: StandaloneSyncInput, projectRoot: string): StandaloneUpdateResult {
  const resolved = validatePath(input.file, projectRoot);
  if (!resolved) return { success: false, reason: 'invalid file path or path traversal detected' };

  // openAndValidate handles file-not-found and does proper TOCTOU-safe validation.
  // The redundant existsSync check is removed to avoid creating a false sense of
  // validation with a TOCTOU window.
  const validated = openAndValidate(resolved, projectRoot);
  if (!validated) return { success: false, reason: 'could not read or validate file' };

  let content = validated.content;

  // Guard against empty oldContent — String.includes('') always returns true
  // Trim to match inline.ts behaviour — whitespace-only strings produce
  // misleading errors downstream (.includes('   ') always matches anything).
  if (!input.oldContent?.trim() || !input.newContent?.trim()) return { success: false, reason: 'empty oldContent or newContent' };

  // Find the section by anchor (heading) using line-by-line parsing.
  // Pass the already-read content to avoid a TOCTOU race from a second disk read.
  const sectionContent = findSectionContentFromString(content, input.anchor);
  if (!sectionContent) return { success: false, reason: `section '${input.anchor}' not found in file` };
  if (!sectionContent.includes(input.oldContent)) return { success: false, reason: 'oldContent not found in section' };

  // Use replace (not replaceAll) to replace only the FIRST occurrence.
  // replaceAll would silently replace ALL occurrences of oldContent within
  // the section, corrupting the documentation when oldContent text appears
  // multiple times (e.g., a parameter name 'id' appearing in multiple
  // descriptions or code examples within the same heading section).
  // Use function-based replacement to avoid $ special-pattern injection.
  const updatedSection = sectionContent.replace(input.oldContent, () => input.newContent);
  content = content.replace(sectionContent, () => updatedSection);

  // Atomic write: use project-local temp directory with restrictive permissions
  const tmpDir = path.join(projectRoot, '.docrel', 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 }); } catch { return { success: false, reason: 'could not create temp directory' }; }
  const tmpPath = path.join(tmpDir, `docrel-${crypto.randomUUID()}.tmp`);
  // Capture original file mode before rename replaces the inode
  let originalMode: number | undefined;
  try { originalMode = fs.statSync(resolved).mode; } catch { /* proceed without mode */ }
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(tmpPath, resolved);
    // Restore original permissions — rename replaces the inode
    if (originalMode !== undefined) {
      try { fs.chmodSync(resolved, originalMode); } catch { /* best effort */ }
    }
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return { success: false, reason: 'atomic write failed' };
  }

  return { success: true };
}

/**
 * Find the content of a markdown section identified by anchor (heading text).
 * Uses line-by-line parsing to correctly handle # characters inside code blocks.
 * @param file Relative or absolute file path (resolved against projectRoot if relative)
 */
export function findSectionContent(file: string, anchor: string, projectRoot: string): string | null {
  if (!anchor) return null;
  if (!projectRoot) return null;

  const resolved = path.resolve(projectRoot, file);

  // Containment check: ensure resolved path is within project root
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
  } catch (err: any) {
    // Catch ALL errors from realpathSync to prevent information disclosure.
    // The error message contains absolute filesystem paths, and these errors
    // propagate through engine.ts into SyncResult.errors, which may be
    // serialized as JSON to CLI or MCP clients.
    // However, distinguish legitimate access errors (EACCES, EIO, ELOOP,
    // ENAMETOOLONG) from ENOENT and path-traversal — a file that exists
    // and is within projectRoot but cannot be resolved should produce a
    // diagnostic instead of silently returning null.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EIO' || code === 'ELOOP' || code === 'ENAMETOOLONG') {
      console.warn(`DocRel: cannot resolve real path for ${path.relative(root, resolved)} — ${code}`);
    }
    return null;
  }

  // Use fd-based file operations to eliminate the TOCTOU window between
  // path validation, stat checks, and the actual read. opensync + fstatSync
  // + readFileSync on the same fd guarantees we operate on a single inode.
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) {
      return null;
    }
    // Re-validate real path via the fd to prevent symlink races
    const real = fs.realpathSync(resolved);
    const root = path.resolve(projectRoot);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
    const content = fs.readFileSync(fd, 'utf-8');
    return findSectionContentFromString(content, anchor);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Extract a markdown section from an already-read content string.
 * Avoids a second disk read (TOCTOU-safe when the caller already read the file).
 */
const MAX_ANCHOR_LENGTH = 1000;

export function findSectionContentFromString(content: string, anchor: string): string | null {
  if (!anchor) return null;
  if (anchor.length > MAX_ANCHOR_LENGTH) {
    console.warn(`DocRel: anchor rejected — length ${anchor.length} exceeds max ${MAX_ANCHOR_LENGTH}`);
    return null;
  }

  const lines = content.split('\n');
  let startLine = -1;
  let startLevel = 0;

  const escapedAnchor = escapeRegex(anchor);

  // Track fenced code block state so # characters inside code blocks are
  // not incorrectly matched as headings or heading-level boundaries.
  // Supports both ``` and ~~~ fences of 3+ characters at line start.
  // Uses a regex that captures the fence token and verifies that any trailing
  // characters on the line are only whitespace or the same fence character.
  let inCodeBlock = false;
  let fenceToken = '';
  const fenceOpenRegex = /^(```+|~~~+)\s*$/;

  // Require exact heading match — nothing after the anchor text except optional trailing whitespace
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track code fence toggles before evaluating heading regex
    if (!inCodeBlock) {
      const fenceMatch = line.match(fenceOpenRegex);
      if (fenceMatch) {
        inCodeBlock = true;
        fenceToken = fenceMatch[1];
        continue;
      }
    } else {
      const fenceMatch = line.match(fenceOpenRegex);
      if (fenceMatch && fenceMatch[1].startsWith(fenceToken[0]) && fenceMatch[1].length >= fenceToken.length) {
        inCodeBlock = false;
        fenceToken = '';
      }
      continue;
    }

    const match = line.match(new RegExp(`^(#{1,6})\\s+${escapedAnchor}\\s*$`));
    if (match) {
      startLine = i;
      startLevel = match[1].length;
      break;
    }
  }
  if (startLine < 0) return null;

  // Reset code fence tracking for the end-boundary scan
  inCodeBlock = false;
  fenceToken = '';

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    // Track code fence toggles before evaluating heading regex
    if (!inCodeBlock) {
      const fenceMatch = line.match(fenceOpenRegex);
      if (fenceMatch) {
        inCodeBlock = true;
        fenceToken = fenceMatch[1];
        continue;
      }
    } else {
      const fenceMatch = line.match(fenceOpenRegex);
      if (fenceMatch && fenceMatch[1].startsWith(fenceToken[0]) && fenceMatch[1].length >= fenceToken.length) {
        inCodeBlock = false;
        fenceToken = '';
      }
      continue;
    }

    const match = line.match(/^(#{1,6})\s/);
    if (match && match[1].length <= startLevel) {
      endLine = i;
      break;
    }
  }

  return lines.slice(startLine, endLine).join('\n');
}
