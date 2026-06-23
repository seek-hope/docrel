// src/sync/inline.ts
import fs from 'node:fs';
import path from 'node:path';

export interface InlineSyncInput {
  file: string;
  symbolName: string;
  oldSignature: string;
  newSignature: string;
  oldDocstring: string;
  newDocstring: string;
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

export function updateInlineDoc(input: InlineSyncInput, projectRoot: string): boolean {
  const resolved = validatePath(input.file, projectRoot);
  if (!resolved) return false;

  if (!fs.existsSync(resolved)) return false;

  let content = fs.readFileSync(resolved, 'utf-8');

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

  // Atomic write: write to temp file then rename
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

function countOccurrences(content: string, search: string): number {
  return (content.match(escapeRegexGlobal(search)) || []).length;
}

function escapeRegexGlobal(str: string): RegExp {
  return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

export function extractDocstring(file: string, symbolName: string, projectRoot?: string): string | null {
  const resolved = projectRoot ? validatePath(file, projectRoot) : file;
  if (!resolved || !fs.existsSync(resolved)) return null;

  const content = fs.readFileSync(resolved, 'utf-8');
  const lines = content.split('\n');
  const symbolLine = lines.findIndex((l) => {
    // Skip lines that are inside string literals or comments
    const codePart = l.replace(/("[^"]*"|'[^']*'|`[^`]*`|\/\/.*|\/\*.*?\*\/)/g, '');
    return (
      codePart.includes(`function ${symbolName}`) ||
      codePart.includes(`class ${symbolName}`) ||
      codePart.includes(`const ${symbolName}`) ||
      codePart.includes(`${symbolName}(`)
    );
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
