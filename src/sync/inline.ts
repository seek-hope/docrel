// src/sync/inline.ts
import fs from 'node:fs';
import path from 'node:path';
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
const MAX_SEARCH_LENGTH = 10_000; // Practical limit to prevent ReDoS from crafted regex input

/** Resolve and validate that filePath is within projectRoot. Returns resolved path or null. */
import { validatePath, escapeRegex, escapeRegexGlobal } from '../utils/fs.js';

export function updateInlineDoc(input: InlineSyncInput, projectRoot: string): boolean {
  const resolved = validatePath(input.file, projectRoot);
  if (!resolved) {
    console.warn('DocRel: updateInlineDoc failed — invalid file path or path traversal detected:', input.file);
    return false;
  }

  // Use file descriptor for TOCTOU-safe read — open once, operate on same inode
  let fd: number | undefined;
  let content: string;
  try {
    fd = fs.openSync(resolved, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      console.warn('DocRel: updateInlineDoc failed — not a regular file:', resolved);
      return false;
    }
    if (stat.size > MAX_FILE_SIZE) {
      console.warn('DocRel: updateInlineDoc failed — file exceeds size limit:', resolved, stat.size);
      return false;
    }
    content = fs.readFileSync(fd, 'utf-8');
  } catch (err: any) {
    console.warn('DocRel: updateInlineDoc failed — could not read file:', resolved, err?.message ?? err);
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }

  let replaced = false;

  // Compute occurrence counts on the ORIGINAL content before any mutations.
  // Strip all comments and strings from the content used to count signature
  // occurrences — prevents the old signature text inside a docstring from
  // inflating the count and causing the signature replacement to be skipped.
  // Strip ALL block comments (including JSDoc) first, then per-line
  // comments and strings, so JSDoc body lines (e.g., '* Processes login()')
  // do not inflate the occurrence count.
  const contentNoComments = stripCommentsAndStrings(stripAllBlockComments(content));
  // Check for empty input separately from countOccurrences returning -1
  // (which means the search string exceeds MAX_SEARCH_LENGTH).
  // Previously both cases set sigCount/docCount to -1, conflating "empty input"
  // with "oversized search string" in the warning messages below.
  const sigInputEmpty = !input.oldSignature?.trim() || !input.newSignature?.trim();
  const docInputEmpty = !input.oldDocstring?.trim() || !input.newDocstring?.trim();
  const sigCount = sigInputEmpty
    ? -2 : countOccurrences(contentNoComments, input.oldSignature);
  // Use content with non-JSDoc comments and strings stripped for docstring
  // counting. This prevents oldDocstring text appearing inside string literals
  // or non-JSDoc comments from inflating the count. JSDoc comments (/** */),
  // line comments (//), and string literals are stripped, so only the actual
  // docstring in the JSDoc block should produce a match.
  const contentNoJsdocStrings = stripNonJsdocBlockComments(content);
  const docCount = docInputEmpty
    ? -2 : countOccurrences(contentNoJsdocStrings, input.oldDocstring);

  // Distinguish aborted searches (>10,000 char) from genuinely empty inputs.
  // countOccurrences returns -1 when the search string exceeds MAX_SEARCH_LENGTH.
  if (sigCount === -2) {
    console.warn('DocRel: updateInlineDoc skipped signature — old or new signature is empty');
  } else if (sigCount === -1) {
    console.warn(`DocRel: updateInlineDoc skipped signature — old signature exceeds ${MAX_SEARCH_LENGTH} chars (possibly corrupted symbol record)`);
  }
  if (docCount === -2) {
    console.warn('DocRel: updateInlineDoc skipped docstring — old or new docstring is empty');
  } else if (docCount === -1) {
    console.warn(`DocRel: updateInlineDoc skipped docstring — old docstring exceeds ${MAX_SEARCH_LENGTH} chars (possibly corrupted symbol record)`);
  }

  if (sigCount === 1) {
    // Guard against replacing the wrong occurrence: if the old signature
    // appears once in non-comment code but multiple times in the full content
    // (e.g., once in a comment before the definition), skip the replacement
    // to avoid corrupting the wrong location.
    if (countOccurrences(content, input.oldSignature) !== 1) {
      console.warn(`DocRel: updateInlineDoc skipped signature replacement — old signature count mismatch (non-comment: 1, full: ${countOccurrences(content, input.oldSignature)})`);
      return false;
    }
    // Use function-based replacement to avoid $ special-pattern injection.
    // String.replace interprets $&, $', $`, $$, and $n as special patterns,
    // which would silently corrupt replacement text containing these sequences.
    content = content.replace(input.oldSignature, () => input.newSignature);
    replaced = true;
  } else if (sigCount > 1) {
    console.warn(`DocRel: updateInlineDoc skipped signature — old signature count is ${sigCount} (expected 1)`);
  }
  // If count is 0 or >1, skip to avoid replacing wrong text

  if (docCount === 1) {
    content = content.replace(input.oldDocstring, () => input.newDocstring);
    replaced = true;
  } else if (docCount > 1) {
    console.warn(`DocRel: updateInlineDoc skipped docstring — old docstring count is ${docCount} (expected 1)`);
  }

  // If the signature was supposed to be replaced but was skipped due to
  // ambiguity (sigCount > 1), refuse to return true even when the docstring
  // replacement succeeded. A stale signature paired with a fresh docstring
  // would incorrectly mark the doc as in_sync when it's only partially updated.
  if (replaced && sigCount > 1) {
    console.warn('DocRel: updateInlineDoc — signature ambiguous, refusing partial update');
    return false;
  }

  if (!replaced) {
    console.warn(`DocRel: updateInlineDoc had nothing to replace (sigCount=${sigCount}, docCount=${docCount})`);
    return false;
  }

  // Post-replacement validation: verify the new signature and docstring appear
  // exactly once in the final content. A count != 1 indicates a mis-replacement.
  if (sigCount === 1 && countOccurrences(content, input.newSignature) !== 1) {
    console.warn('DocRel: updateInlineDoc post-validation failed — new signature count != 1');
    return false;
  }
  if (docCount === 1 && countOccurrences(content, input.newDocstring) !== 1) {
    console.warn('DocRel: updateInlineDoc post-validation failed — new docstring count != 1');
    return false;
  }

  // Atomic write: use project-local temp directory with restrictive permissions.
  // Prefer local over os.tmpdir() to stay within the project's permission boundary
  // and avoid cross-filesystem EXDEV errors from rename().
  const tmpDir = path.join(projectRoot, '.docrel', 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 }); } catch {
    console.warn('DocRel: updateInlineDoc failed — could not create temp directory:', tmpDir);
    return false;
  }
  const tmpPath = path.join(tmpDir, `docrel-${crypto.randomUUID()}.tmp`);
  // Capture original file mode before rename replaces the inode
  let originalMode: number | undefined;
  try { originalMode = fs.statSync(resolved).mode; } catch { /* proceed without mode */ }
  try {
    // Use exclusive creation flag to fail if file already exists
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(tmpPath, resolved);
    // Restore original permissions — rename replaces the inode, so the temp
    // file's default permissions (typically 0600) replace the original's.
    if (originalMode !== undefined) {
      try { fs.chmodSync(resolved, originalMode); } catch { /* best effort */ }
    }
  } catch (err: any) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.warn('DocRel: updateInlineDoc atomic write failed:', err?.message ?? err);
    return false;
  }

  return true;
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  const regex = escapeRegexGlobal(search, MAX_SEARCH_LENGTH);
  if (!regex) return -1; // search string too long — signal aborted search
  return (content.match(regex) || []).length;
}

/**
 * Extract the docstring preceding a symbol definition.
 * Uses a state-machine approach to strip comments and strings safely,
 * avoiding catastrophic backtracking from monolithic regex.
 */
export function extractDocstring(file: string, symbolName: string, projectRoot: string): string | null {
  if (!projectRoot) return null;
  const resolved = validatePath(file, projectRoot);
  if (!resolved || !fs.existsSync(resolved)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;

  let content = fs.readFileSync(resolved, 'utf-8');
  // Strip all multi-line block comments (/* ... */) from the full content
  // before per-line processing. Use a state machine instead of a regex to
  // avoid catastrophic backtracking on files with unclosed block comments.
  // Exclude JSDoc-style comments (/** ... */) which are the very docstrings
  // we aim to extract.
  content = stripNonJsdocBlockComments(content);
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
  const n = escapeRegex(symbolName);
  // Match only definition patterns.
  // Includes class method definitions like 'async login(...)' or 'login(data) {'
  // which lack a keyword prefix. The '{' or '=>' guard distinguishes definitions
  // from call sites like `return login(data);`.
  return new RegExp(
    `(?:export\\s+)?(?:async\\s+)??(?:function|class)\\s+${n}\\b` +
    `|(?:export\\s+)?(?:const|let|var)\\s+${n}\\b` +
    `|\\binterface\\s+${n}\\b` +
    `|\\btype\\s+${n}\\b` +
    `|(?:async\\s+)?${n}\\s*\\(.*?\\)\\s*[{:]`,
  );
}

/**
 * Strip comments and strings from a single line using a character-by-character
 * state machine. This avoids catastrophic backtracking that can occur with
 * monolithic regex patterns on crafted input.
 */
/**
 * Strip non-JSDoc block comments (/* ... *​/) from full content using a
 * simple state machine. This avoids catastrophic backtracking from the
 * monolithic regex `/\/\*[^*][\s\S]*?\*\//g` on inputs with unclosed
 * block comments.
 */
function stripNonJsdocBlockComments(content: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    // Track string literals to avoid stripping /* ... */ inside strings
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '"') {
      out.push(ch); i++;
      while (i < content.length) {
        out.push(content[i]);
        if (content[i] === '\\') {
          if (i + 1 >= content.length) { i++; break; }
          out.push(content[i + 1] ?? ''); i += 2; continue;
        }
        if (content[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "'") {
      out.push(ch); i++;
      while (i < content.length) {
        out.push(content[i]);
        if (content[i] === '\\') {
          if (i + 1 >= content.length) { i++; break; }
          out.push(content[i + 1] ?? ''); i += 2; continue;
        }
        if (content[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '`') {
      out.push(ch); i++;
      let nestDepth = 0;
      while (i < content.length) {
        out.push(content[i]);
        if (content[i] === '\\') {
          if (i + 1 >= content.length) { i++; break; }
          out.push(content[i + 1] ?? ''); i += 2; continue;
        }
        if (content[i] === '$' && content[i + 1] === '{') {
          nestDepth++; i++; continue;
        }
        if (content[i] === '}' && nestDepth > 0) {
          nestDepth--; i++; continue;
        }
        if (content[i] === '`' && nestDepth === 0) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      // Block comment — strip if NOT JSDoc (/** ... */)
      if (content[i + 2] === '*') {
        // JSDoc comment — keep it
        out.push(ch); i++;
        continue;
      }
      // Non-JSDoc block comment — scan forward for closing */
      i += 2;
      while (i < content.length - 1) {
        if (content[i] === '*' && content[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

/**
 * Strip ALL block comments (both /* ... *​/ and /** ... *​/) from content using
 * a state machine. Used before counting signature occurrences to prevent JSDoc
 * body lines (e.g., '* Processes login(username: string): User') containing
 * the old signature text from inflating the count.
 */
function stripAllBlockComments(content: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '"') {
      out.push(ch); i++;
      while (i < content.length) {
        out.push(content[i]);
        if (content[i] === '\\') {
          if (i + 1 >= content.length) { i++; break; }
          out.push(content[i + 1] ?? ''); i += 2; continue;
        }
        if (content[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "'") {
      out.push(ch); i++;
      while (i < content.length) {
        out.push(content[i]);
        if (content[i] === '\\') {
          if (i + 1 >= content.length) { i++; break; }
          out.push(content[i + 1] ?? ''); i += 2; continue;
        }
        if (content[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '`') {
      out.push(ch); i++;
      let nestDepth = 0;
      while (i < content.length) {
        out.push(content[i]);
        if (content[i] === '\\') {
          if (i + 1 >= content.length) { i++; break; }
          out.push(content[i + 1] ?? ''); i += 2; continue;
        }
        if (content[i] === '$' && content[i + 1] === '{') {
          nestDepth++; i++; continue;
        }
        if (content[i] === '}' && nestDepth > 0) {
          nestDepth--; i++; continue;
        }
        if (content[i] === '`' && nestDepth === 0) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      // Block comment (including JSDoc /** ... */) — skip entirely
      i += 2;
      while (i < content.length - 1) {
        if (content[i] === '*' && content[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

export function stripCommentsAndStrings(line: string): string {
  // Safety: operates per-line only — each while loop is bounded by line.length.
  // Multi-line strings are not supported; input is always split by '\n' first.
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];

    // Double-quoted string (bounded by line length)
    if (c === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') {
          if (i + 1 >= line.length) { i++; break; }
          i += 2; continue;
        }
        if (line[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    // Single-quoted string
    if (c === "'") {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') {
          if (i + 1 >= line.length) { i++; break; }
          i += 2; continue;
        }
        if (line[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // Template literal — track ${...} nesting depth so that inner
    // template literals (e.g., css`...${func(`inner`)}...`) do not
    // prematurely terminate the state machine's string tracking.
    if (c === '`') {
      i++;
      let nestDepth = 0;
      while (i < line.length) {
        if (line[i] === '\\') {
          if (i + 1 >= line.length) { i++; break; }
          i += 2; continue;
        }
        if (line[i] === '$' && line[i + 1] === '{') {
          nestDepth++;
          i += 2;
          continue;
        }
        if (line[i] === '}' && nestDepth > 0) {
          nestDepth--;
          i++;
          continue;
        }
        if (line[i] === '`' && nestDepth === 0) { i++; break; }
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
  _oldSignature: string,
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
  // Use bracket-counting to handle nested parentheses in TypeScript signatures,
  // e.g. `foo(cb: (x: number) => void): string`
  const parenStart = signature.indexOf('(');
  if (parenStart < 0) return [];

  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < signature.length; i++) {
    if (signature[i] === '(') depth++;
    else if (signature[i] === ')') {
      depth--;
      if (depth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd < 0) return [];

  const paramsStr = signature.slice(parenStart + 1, parenEnd);
  if (!paramsStr.trim()) return [];

  return splitParams(paramsStr).map((p) => {
    const parts = p.trim().split(':');
    return { name: parts[0]?.trim() ?? 'arg', type: parts[1]?.trim() ?? 'any' };
  }).filter((p) => p.name.length > 0);
}

/** Split comma-separated params, respecting nested angle brackets, parentheses,
 *  AND string literals. A comma inside a quoted string (e.g. name: string = "hello, world")
 *  is not a delimiter. */
function splitParams(paramsStr: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  let inString: string | null = null; // '"', "'", or '`' when inside a string literal
  let nestDepth = 0; // tracks ${...} nesting inside template literals
  for (let i = 0; i < paramsStr.length; i++) {
    const ch = paramsStr[i];
    if (inString) {
      current += ch;
      if (ch === '\\') { current += paramsStr[i + 1] ?? ''; i++; continue; }
      // Handle ${...} nesting inside template literals — prevent inner
      // backticks from prematurely terminating the string tracking.
      if (inString === '`') {
        if (ch === '$' && paramsStr[i + 1] === '{') { nestDepth++; continue; }
        if (ch === '}' && nestDepth > 0) { nestDepth--; continue; }
      }
      if (ch === inString && nestDepth === 0) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current);
  return result;
}
