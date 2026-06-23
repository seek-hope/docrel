// src/sync/inline.ts
import fs from 'node:fs';

export interface InlineSyncInput {
  file: string;
  symbolName: string;
  oldSignature: string;
  newSignature: string;
  oldDocstring: string;
  newDocstring: string;
}

export function updateInlineDoc(input: InlineSyncInput): boolean {
  if (!fs.existsSync(input.file)) return false;

  let content = fs.readFileSync(input.file, 'utf-8');

  // Find the symbol definition and its associated docstring/comment
  // Replace the old signature/docstring with new
  if (input.oldSignature && input.newSignature) {
    content = content.replace(input.oldSignature, input.newSignature);
  }

  if (input.oldDocstring && input.newDocstring) {
    content = content.replace(input.oldDocstring, input.newDocstring);
  }

  fs.writeFileSync(input.file, content, 'utf-8');
  return true;
}

export function extractDocstring(file: string, symbolName: string): string | null {
  if (!fs.existsSync(file)) return null;

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const symbolLine = lines.findIndex((l) =>
    l.includes(`function ${symbolName}`) ||
    l.includes(`class ${symbolName}`) ||
    l.includes(`const ${symbolName}`) ||
    l.includes(`${symbolName}(`),
  );

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
