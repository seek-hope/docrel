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

import { validatePath, escapeRegex, escapeRegexGlobal } from '../utils/fs.js';

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
      fd = undefined;
      return null;
    }
    // Re-validate real path using the actual open file descriptor instead of
    // the filesystem path. This eliminates the TOCTOU gap where an attacker
    // could swap a symlink between openSync and realpathSync.
    // /proc/self/fd is Linux-only — fall back to path-based validation on
    // other platforms (macOS, Windows), matching the pattern in findSectionContent.
    const root = path.resolve(projectRoot);
    if (process.platform === 'linux') {
      const fdReal = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!fdReal.startsWith(root + path.sep) && fdReal !== root) {
        fs.closeSync(fd);
        fd = undefined;
        return null;
      }
    }
    const content = fs.readFileSync(fd, 'utf-8');
    return { content };
  } catch (err: any) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      console.warn(`DocRelay: openAndValidate failed for ${resolved}:`, err instanceof Error ? err.message : err);
    }
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
  // Normalize line endings (CRLF → LF) before comparison. If oldContent from
  // the DB has CRLF but the file on disk has LF (or vice versa), includes()
  // fails and the doc sync silently aborts. Matches the normalizeDocLines()
  // pattern used in inline.ts replacePythonDocstring/Go/Rust.
  const normalizedSection = sectionContent.replace(/\r\n/g, '\n');
  const normalizedOld = input.oldContent.replace(/\r\n/g, '\n');
  if (!normalizedSection.includes(normalizedOld)) return { success: false, reason: 'oldContent not found in section' };

  // After the normalized guard check passes, align oldContent to the file's
  // actual line endings before the replace. Without this alignment, a CRLF/LF
  // mismatch causes String.replace to silently return the original string
  // unchanged, and the function falsely reports success while making no
  // modifications — leaving the doc permanently stale.
  const fileUsesCRLF = sectionContent.includes('\r\n');
  const alignedOld = fileUsesCRLF
    ? input.oldContent.replace(/\r?\n/g, '\r\n')
    : input.oldContent.replace(/\r\n/g, '\n');
  const alignedNew = fileUsesCRLF
    ? input.newContent.replace(/\r?\n/g, '\r\n')
    : input.newContent.replace(/\r\n/g, '\n');
  // Count occurrences of oldContent in the section before replacing.
  // If oldContent appears 0 or >1 times, refuse the replacement — matching
  // the safety layer in inline.ts (lines 148-200) which rejects ambiguous
  // replacements where a text appears multiple times within the target.
  const oldRegex = escapeRegexGlobal(alignedOld);
  if (!oldRegex) return { success: false, reason: 'oldContent too long for occurrence counting' };
  let oldCount = 0;
  for (const _ of sectionContent.matchAll(oldRegex)) {
    if (++oldCount > 1) break;
  }
  if (oldCount !== 1) return { success: false, reason: `oldContent appears ${oldCount} times in section (expected 1)` };

  // Use replace (not replaceAll) to replace only the FIRST occurrence.
  // replaceAll would silently replace ALL occurrences of oldContent within
  // the section, corrupting the documentation when oldContent text appears
  // multiple times (e.g., a parameter name 'id' appearing in multiple
  // descriptions or code examples within the same heading section).
  // Use function-based replacement to avoid $ special-pattern injection.
  const updatedSection = sectionContent.replace(alignedOld, () => alignedNew);
  content = content.replace(sectionContent, () => updatedSection);

  // Post-replacement validation: verify oldContent no longer appears and
  // newContent appears exactly once in the updated section (matching the
  // post-replacement validation in inline.ts at lines 234-241).
  let postOldCount = 0;
  for (const _ of updatedSection.matchAll(oldRegex)) {
    postOldCount = 1; // any match is a failure
    break;
  }
  if (postOldCount > 0) {
    return { success: false, reason: 'post-validation failed — oldContent still present after replacement' };
  }
  const newRegex = escapeRegexGlobal(alignedNew);
  if (newRegex) {
    let newCount = 0;
    for (const _ of updatedSection.matchAll(newRegex)) {
      if (++newCount > 1) break;
    }
    if (newCount !== 1) {
      return { success: false, reason: `post-validation failed — newContent appears ${newCount} times (expected 1)` };
    }
  }

  // Atomic write: use project-local temp directory with restrictive permissions
  const tmpDir = path.join(projectRoot, '.docrelay', 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 }); } catch (err: any) { return { success: false, reason: `could not create temp directory: ${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}` }; }
  const tmpPath = path.join(tmpDir, `docrelay-${crypto.randomUUID()}.tmp`);
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
  // Declare `real` outside the try so it is accessible in the fd-based
  // block below, where we open the canonical path instead of the lexical
  // path (F11: TOCTOU gap between containment check and open).
  let real: string;
  try {
    real = fs.realpathSync(resolved);
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
      console.warn(`DocRelay: cannot resolve real path for ${path.relative(root, resolved)} — ${code}`);
    }
    return null;
  }

  // Use fd-based file operations to eliminate the TOCTOU window between
  // path validation, stat checks, and the actual read. opensync + fstatSync
  // + readFileSync on the same fd guarantees we operate on a single inode.
  let fd: number | undefined;
  try {
    // F11: Open the canonical `real` path (validated at lines 125-127) instead
    // of the lexical `resolved` path. Between the two synchronous calls, a
    // concurrent process could swap a symlink at `resolved` to point outside
    // the project root, bypassing the containment check.
    fd = fs.openSync(real, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) {
      return null;
    }
    // F3: Re-validate real path via the file descriptor instead of the
    // filesystem path. This eliminates the TOCTOU gap where a local attacker
    // could swap a symlink between openSync and realpathSync.
    // Use /proc/self/fd on Linux; fall back to path-based validation on
    // non-Linux platforms where /proc/self/fd is unavailable.
    if (process.platform === 'linux') {
      const fdReal = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!fdReal.startsWith(root + path.sep) && fdReal !== root) return null;
    } else {
      const fdReal = fs.realpathSync(real);
      if (!fdReal.startsWith(root + path.sep) && fdReal !== root) return null;
    }
    const content = fs.readFileSync(fd, 'utf-8');
    return findSectionContentFromString(content, anchor);
  } catch (err: any) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      console.warn(`DocRelay: findSectionContent failed for ${file}:`, err instanceof Error ? err.message : err);
    }
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
    console.warn(`DocRelay: anchor rejected — length ${anchor.length} exceeds max ${MAX_ANCHOR_LENGTH}`);
    return null;
  }

  const MAX_SECTION_LINES = 100_000;
  // Guard against pathological files with millions of short lines in
  // the 10MB-bounded content. Pre-scan newline count before splitting to
  // prevent the array allocation from OOM-ing on 2-char-per-line files.
  // (Round 17: the round 9 guard was post-split — content.split('\n')
  // allocated the full array before the lines.length check could reject
  // it. Same pattern fixed in 6 other locations in rounds 14 and 15.)
  let sectionNewlineCount = 1;
  for (let si = 0; si < content.length && sectionNewlineCount <= MAX_SECTION_LINES + 1; si++) {
    if (content[si] === '\n') sectionNewlineCount++;
  }
  if (sectionNewlineCount > MAX_SECTION_LINES) {
    console.warn(`DocRelay: findSectionContentFromString — content has ${sectionNewlineCount} lines, exceeds limit of ${MAX_SECTION_LINES}`);
    return null;
  }
  const lines = content.split('\n');
  let startLine = -1;
  let startLevel = 0;

  const escapedAnchor = escapeRegex(anchor);

  // Track fenced code block state so # characters inside code blocks are
  // not incorrectly matched as headings or heading-level boundaries.
  // Supports both ``` and ~~~ fences of 3+ characters at line start.
  // Opening fences may have a language identifier (e.g., ```typescript);
  // closing fences must be the bare token with only optional trailing whitespace.
  let inCodeBlock = false;
  let fenceToken = '';

  // Require exact heading match — nothing after the anchor text except optional trailing whitespace
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track code fence toggles before evaluating heading regex
    const fenceMatch = line.match(/^(```+|~~~+)(.*)/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      const afterFence = fenceMatch[2].trim();
      if (!inCodeBlock) {
        // Opening fence — language identifier is allowed
        inCodeBlock = true;
        fenceToken = token;
        continue;
      }
      // Closing fence — same character type, at least as long, and
      // nothing but whitespace after the fence characters.
      if (token.startsWith(fenceToken[0]) && token.length >= fenceToken.length && afterFence === '') {
        inCodeBlock = false;
        fenceToken = '';
      }
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(new RegExp(`^\\s{0,3}(#{1,6})\\s+${escapedAnchor}\\s*$`));
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
    const fenceMatch = line.match(/^(```+|~~~+)(.*)/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      const afterFence = fenceMatch[2].trim();
      if (!inCodeBlock) {
        // Opening fence — language identifier is allowed
        inCodeBlock = true;
        fenceToken = token;
        continue;
      }
      // Closing fence — same character type, at least as long, and
      // nothing but whitespace after the fence characters.
      if (token.startsWith(fenceToken[0]) && token.length >= fenceToken.length && afterFence === '') {
        inCodeBlock = false;
        fenceToken = '';
      }
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^(#{1,6})\s/);
    if (match && match[1].length <= startLevel) {
      endLine = i;
      break;
    }
  }

  return lines.slice(startLine, endLine).join('\n');
}
