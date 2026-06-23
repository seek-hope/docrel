// src/sync/inline.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface InlineSyncInput {
  file: string;
  symbolName: string;
  oldSignature: string;
  newSignature: string;
  oldDocstring: string;
  newDocstring: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_SEARCH_LENGTH = 100_000;

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

export function updateInlineDoc(input: InlineSyncInput, projectRoot: string): boolean {
  const resolved = validatePath(input.file, projectRoot);
  if (!resolved) return false;

  if (!fs.existsSync(resolved)) return false;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size > MAX_FILE_SIZE) return false;

  // Open file before content-validating to reduce TOCTOU window
  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch {
    return false;
  }

  let replaced = false;

  // Only replace if the old text appears exactly once (avoid ambiguity)
  if (input.oldSignature && input.newSignature) {
    const count = countOccurrences(content, input.oldSignature);
    if (count === 1) {
      content = content.replace(input.oldSignature, input.newSignature);
      replaced = true;
    }
    // If count is 0 or >1, skip to avoid replacing wrong text
  }

  if (input.oldDocstring && input.newDocstring) {
    const count = countOccurrences(content, input.oldDocstring);
    if (count === 1) {
      content = content.replace(input.oldDocstring, input.newDocstring);
      replaced = true;
    }
  }

  if (!replaced) return false;

  // Atomic write: use os.tmpdir() with random name (not deterministic path)
  const tmpPath = path.join(os.tmpdir(), `docrel-${crypto.randomUUID()}.tmp`);
  try {
    // Use exclusive creation flag to fail if file already exists
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(tmpPath, resolved);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }

  return true;
}

function countOccurrences(content: string, search: string): number {
  return (content.match(escapeRegexGlobal(search)) || []).length;
}

function escapeRegexGlobal(str: string): RegExp {
  if (str.length > MAX_SEARCH_LENGTH) {
    // If too large, return a regex that won't match anything
    return /(?!)a^/;
  }
  return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

/**
 * Extract the docstring preceding a symbol definition.
 * Uses a state-machine approach to strip comments and strings safely,
 * avoiding catastrophic backtracking from monolithic regex.
 */
export function extractDocstring(file: string, symbolName: string, projectRoot?: string): string | null {
  const resolved = projectRoot ? validatePath(file, projectRoot) : file;
  if (!resolved || !fs.existsSync(resolved)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;

  const content = fs.readFileSync(resolved, 'utf-8');
  const lines = content.split('\n');

  const symRegex = escapedSymRegex(symbolName);

  const symbolLine = lines.findIndex((l) => {
    // Strip comments and strings using a simple state machine
    const codePart = stripCommentsAndStrings(l);
    return symRegex.test(codePart);
  });

  if (symbolLine < 0) return null;

  // Walk backwards to find the preceding comment block (JSDoc or multi-line)
  const commentLines: string[] = [];
  for (let i = symbolLine - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
      commentLines.unshift(lines[i]);
    } else if (commentLines.length > 0) {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines.join('\n') : null;
}

/**
 * Build a regex that matches a symbol definition broadly:
 *   export async function symbolName
 *   export function symbolName
 *   async function symbolName
 *   function symbolName
 *   class symbolName
 *   export class symbolName
 *   const/let/var symbolName = ( =>  (arrow functions)
 *   symbolName (    (method calls on same line, class methods)
 */
function escapedSymRegex(symbolName: string): RegExp {
  const n = escapeRegexChar(symbolName);
  // Match many definition styles in one alternation
  return new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${n}\\b` +
    `|(?:export\\s+)?class\\s+${n}\\b` +
    `|(?:export\\s+)?(?:const|let|var)\\s+${n}\\b` +
    `|\\b${n}\\s*\\(`,
  );
}

function escapeRegexChar(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip comments and strings from a single line using a character-by-character
 * state machine. This avoids catastrophic backtracking that can occur with
 * monolithic regex patterns on crafted input.
 */
function stripCommentsAndStrings(line: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];

    // Double-quoted string
    if (c === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    // Single-quoted string
    if (c === "'") {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // Template literal
    if (c === '`') {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    // Line comment
    if (c === '/' && next === '/') {
      break; // rest of line is comment
    }
    // Block comment start
    if (c === '/' && next === '*') {
      i += 2;
      while (i < line.length - 1) {
        if (line[i] === '*' && line[i + 1] === '/') { i += 2; break; }
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

export function generateUpdatedDocstring(
  symbolName: string,
  kind: string,
  oldSignature: string,
  newSignature: string,
): string {
  // Generate a basic updated JSDoc/docstring based on the new signature
  const params = extractParams(newSignature);
  const lines = ['/**'];
  lines.push(` * ${symbolName} — [auto-updated by DocRel]`);
  for (const param of params) {
    lines.push(` * @param ${param.name} — ${param.type}`);
  }
  if (newSignature.includes('):') || kind === 'function') {
    const returnMatch = newSignature.match(/\):\s*(\S+)/);
    if (returnMatch) {
      lines.push(` * @returns {${returnMatch[1]}}`);
    }
  }
  lines.push(' */');
  return lines.join('\n');
}

function extractParams(signature: string): Array<{ name: string; type: string }> {
  const paramMatch = signature.match(/\((.*?)\)/);
  if (!paramMatch || !paramMatch[1]) return [];

  return paramMatch[1].split(',').map((p) => {
    const parts = p.trim().split(':');
    return { name: parts[0]?.trim() ?? 'arg', type: parts[1]?.trim() ?? 'any' };
  }).filter((p) => p.name.length > 0);
}
