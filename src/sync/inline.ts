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

// ---------------------------------------------------------------------------
// Doc style detection
// ---------------------------------------------------------------------------

type DocStyle = 'jsdoc' | 'python' | 'go' | 'rust';

function detectDocStyle(file: string): DocStyle {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.py':  return 'python';
    case '.go':  return 'go';
    case '.rs':  return 'rust';
    default:     return 'jsdoc'; // .ts .tsx .js .jsx .mjs .cjs .mts .cts
  }
}

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
    // F12: Post-open containment verification via /proc/self/fd on Linux.
    // Between validatePath's realpathSync (line 22) and openSync (line 32),
    // a symlink at `resolved` could be swapped to a different target.
    // Verifying the fd's real path closes this gap, matching openAndValidate
    // in standalone.ts.
    if (process.platform === 'linux') {
      const fdReal = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!fdReal.startsWith(projectRoot + path.sep) && fdReal !== projectRoot) {
        console.warn('DocRel: updateInlineDoc failed — path traversal detected via fd:', resolved);
        return false;
      }
    }
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

  const style = detectDocStyle(input.file);

  // ------------------------------------------------------------------
  // Non-JSDoc languages: use language-specific docstring replacement
  // ------------------------------------------------------------------
  if (style !== 'jsdoc') {
    const docInputEmpty = !input.oldDocstring?.trim() || !input.newDocstring?.trim();
    if (docInputEmpty) {
      console.warn('DocRel: updateInlineDoc skipped docstring — old or new docstring is empty');
      return false;
    }

    let result: string | null = null;
    switch (style) {
      case 'python':
        result = replacePythonDocstring(content, input.symbolName, input.oldDocstring, input.newDocstring);
        break;
      case 'go':
        result = replaceGoDocComment(content, input.symbolName, input.oldDocstring, input.newDocstring);
        break;
      case 'rust':
        result = replaceRustDocComment(content, input.symbolName, input.oldDocstring, input.newDocstring);
        break;
    }

    if (result === null) {
      console.warn(`DocRel: updateInlineDoc — could not replace ${style} docstring for ${input.symbolName} in ${input.file}`);
      return false;
    }

    content = result;
    replaced = true;

    // Post-replacement sanity: verify new docstring appears exactly once
    if (countOccurrences(content, input.newDocstring) !== 1) {
      console.warn('DocRel: updateInlineDoc post-validation failed — new docstring count != 1');
      return false;
    }
  } else {
    // ------------------------------------------------------------------
    // JSDoc (TypeScript / JavaScript) path — existing logic unchanged
    // ------------------------------------------------------------------

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

    // Diagnostic: log when non-comment signature count differs significantly
    // from full-content count. Comment-stripped vs full-content count differences
    // are expected when signatures appear in JSDoc example blocks — the guards at
    // lines 105-108 and 140-143 already protect against actual mismatches.
    if (sigCount >= 0) {
      const fullCount = countOccurrences(content, input.oldSignature);
      if (Math.abs(sigCount - fullCount) > 1) {
        console.debug(`DocRel: updateInlineDoc — signature occurrence count differs between stripped (${sigCount}) and full (${fullCount}) content`);
      }
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
    // If the signature was not found (sigCount === 0) and the caller expected
    // a signature replacement (sigInputEmpty === false), refuse to return true
    // even when the docstring was successfully replaced. Otherwise the doc is
    // partially updated (new docstring, stale signature) but permanently marked
    // as in_sync — future scans won't detect the stale signature.
    if (replaced && sigCount === 0 && sigInputEmpty === false) {
      console.warn('DocRel: updateInlineDoc — signature missing from source, refusing partial update');
      return false;
    }

    if (!replaced) {
      console.warn(`DocRel: updateInlineDoc had nothing to replace (sigCount=${sigCount}, docCount=${docCount})`);
      return false;
    }

    // Post-replacement validation: verify the new signature and docstring appear
    // exactly once in the final content. A count != 1 indicates a mis-replacement.
    // F20: Use sigInputEmpty/docInputEmpty as guards instead of sigCount/docCount,
    // so validation runs whenever a replacement was expected regardless of whether
    // the old count was exactly 1.
    if (sigInputEmpty === false && countOccurrences(content, input.newSignature) !== 1) {
      console.warn('DocRel: updateInlineDoc post-validation failed — new signature count != 1');
      return false;
    }
    if (docInputEmpty === false && countOccurrences(content, input.newDocstring) !== 1) {
      console.warn('DocRel: updateInlineDoc post-validation failed — new docstring count != 1');
      return false;
    }
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

// ---------------------------------------------------------------------------
// Python docstring extraction
// ---------------------------------------------------------------------------

/**
 * Find the colon that ends a Python def/class header, handling:
 *  - multi-line signatures (bracket counting)
 *  - inline comments after the colon
 *  - type annotations after the colon (-> type:)
 * Returns the index just past the colon or -1.
 */
function findPythonHeaderEnd(content: string, start: number): number {
  let i = start;
  let parenDepth = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      parenDepth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      parenDepth--;
    } else if (ch === '#' && parenDepth <= 0) {
      // Inline comment — skip rest of line
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    } else if (ch === ':' && parenDepth <= 0) {
      return i;
    }
    i++;
  }
  return -1;
}

function extractPythonDocstring(content: string, symbolName: string): string | null {
  const escaped = escapeRegex(symbolName);
  // Match 'def name' or 'class Name' — async def also matched
  const defRegex = new RegExp(
    `(?:^|\\n)([ \\t]*)(?:async\\s+)?def\\s+${escaped}\\b|` +
    `(?:^|\\n)([ \\t]*)class\\s+${escaped}\\b`,
    'm',
  );
  const match = defRegex.exec(content);
  if (!match) return null;

  const headerEnd = findPythonHeaderEnd(content, match.index + match[0].length);
  if (headerEnd < 0) return null;

  // Skip past colon, optional return-type annotation, and inline comment
  let i = headerEnd + 1;
  // Skip whitespace and type-annotation on the same line (-> bool:)
  while (i < content.length && content[i] !== '\n' && content[i] !== '#') i++;
  if (content[i] === '#') {
    while (i < content.length && content[i] !== '\n') i++;
  }
  // Now i points at \n or EOF — skip the newline
  if (i < content.length && content[i] === '\n') i++;

  // Walk forward through body lines: skip blanks, skip comments,
  // then the first triple-quoted string is the docstring.
  while (i < content.length) {
    // Skip leading whitespace
    while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;

    if (i >= content.length) return null;

    const ch = content[i];

    // Blank line
    if (ch === '\n' || ch === '\r') { i++; continue; }

    // Comment line
    if (ch === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }

    // Check for triple-quoted string (""" or ''')
    const triple = content.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      const docStart = i;
      i += 3;
      const closeIdx = content.indexOf(triple, i);
      if (closeIdx < 0) return null;
      // Return the entire triple-quoted string including delimiters
      return content.slice(docStart, closeIdx + 3);
    }

    // First non-blank non-comment line is not a triple-quoted string
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Go doc-comment extraction
// ---------------------------------------------------------------------------

function extractGoDocstring(content: string, symbolName: string): string | null {
  const escaped = escapeRegex(symbolName);
  // Match `func (receiver) Name(` or `func Name(` or `type Name `
  const defRegex = new RegExp(
    `(?:^|\\n)(?:func\\s+(?:\\([^)]*\\)\\s+)?${escaped}\\s*\\(|type\\s+${escaped}\\s+)`,
    'm',
  );
  const match = defRegex.exec(content);
  if (!match) return null;

  // Compute line index for the definition — skip the (?:^|\n) prefix so
  // the index lands on the first character of the func/type line.
  const defStart = match.index + (match.index === 0 ? 0 : 1);
  const before = content.slice(0, defStart);
  const defLineIdx = before.split('\n').length - 1;
  const lines = content.split('\n');

  // Walk backwards collecting non-doc // lines (// that are NOT ///)
  const commentLines: string[] = [];
  for (let j = defLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j].trim();
    if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
      commentLines.unshift(lines[j]);
    } else if (trimmed === '') {
      // Empty line between blocks — stop
      if (commentLines.length > 0) break;
    } else {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Rust doc-comment extraction
// ---------------------------------------------------------------------------

function extractRustDocstring(content: string, symbolName: string): string | null {
  const escaped = escapeRegex(symbolName);
  // Match fn/struct/trait/impl definitions — pub / async / unsafe are optional
  const defRegex = new RegExp(
    `(?:^|\\n)(?:pub(?:\\s*\\(\\s*crate\\s*\\))?\\s+)?(?:default\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s+${escaped}\\b|` +
    `(?:^|\\n)(?:pub\\s+)?struct\\s+${escaped}\\b|` +
    `(?:^|\\n)(?:pub\\s+)?(?:unsafe\\s+)?trait\\s+${escaped}\\b|` +
    `(?:^|\\n)(?:pub\\s+)?impl(?:\\s*<[^>]*>)?(?:\\s+\\w+)?\\s+for\\s+${escaped}\\b|` +
    `(?:^|\\n)impl(?:\\s*<[^>]*>)?\\s+${escaped}\\b`,
    'm',
  );
  const match = defRegex.exec(content);
  if (!match) return null;

  // Skip the (?:^|\n) prefix so defLineIdx lands on the first char of the
  // fn/struct/trait/impl line.
  const defStart = match.index + (match.index === 0 ? 0 : 1);
  const before = content.slice(0, defStart);
  const defLineIdx = before.split('\n').length - 1;
  const lines = content.split('\n');
  const commentLines: string[] = [];
  for (let j = defLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j].trim();
    if (trimmed.startsWith('///') || trimmed.startsWith('//!')) {
      commentLines.unshift(lines[j]);
    } else if (trimmed === '') {
      if (commentLines.length > 0) break;
    } else if (trimmed.startsWith('#[')) {
      // Attributes like #[derive(...)] / #[cfg(...)] — keep walking up
      continue;
    } else {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Language-specific docstring replacement helpers (updateInlineDoc)
// ---------------------------------------------------------------------------

/**
 * For Python: locate the triple-quoted docstring after the symbol definition
 * and replace `old` with `new`. Returns modified content or null.
 */
function replacePythonDocstring(
  content: string,
  symbolName: string,
  oldDocstring: string,
  newDocstring: string,
): string | null {
  // Extract to find exact bounds of the existing docstring
  const existing = extractPythonDocstring(content, symbolName);
  if (!existing) return null;

  // Verify the old docstring matches what's actually in the file
  if (existing !== oldDocstring) {
    console.warn(
      `DocRel: replacePythonDocstring — old docstring mismatch.\n` +
      `  expected: ${oldDocstring.slice(0, 80)}...\n` +
      `  found:    ${existing.slice(0, 80)}...`,
    );
    return null;
  }

  // Simple string replacement — the docstring text is unique as a triple-quoted
  // string immediately after the definition header.
  const idx = content.indexOf(oldDocstring);
  if (idx < 0) return null;

  return content.slice(0, idx) + newDocstring + content.slice(idx + oldDocstring.length);
}

/**
 * For Go: locate the // comment block before the symbol and replace it.
 */
function replaceGoDocComment(
  content: string,
  symbolName: string,
  oldDocstring: string,
  newDocstring: string,
): string | null {
  const existing = extractGoDocstring(content, symbolName);
  if (!existing || existing !== oldDocstring) return null;

  const idx = content.indexOf(oldDocstring);
  if (idx < 0) return null;

  return content.slice(0, idx) + newDocstring + content.slice(idx + oldDocstring.length);
}

/**
 * For Rust: locate the /// comment block before the symbol and replace it.
 */
function replaceRustDocComment(
  content: string,
  symbolName: string,
  oldDocstring: string,
  newDocstring: string,
): string | null {
  const existing = extractRustDocstring(content, symbolName);
  if (!existing || existing !== oldDocstring) return null;

  const idx = content.indexOf(oldDocstring);
  if (idx < 0) return null;

  return content.slice(0, idx) + newDocstring + content.slice(idx + oldDocstring.length);
}

/**
 * Extract the docstring preceding a symbol definition.
 * Uses a state-machine approach to strip comments and strings safely,
 * avoiding catastrophic backtracking from monolithic regex.
 */
export function extractDocstring(file: string, symbolName: string, projectRoot: string): string | null {
  if (!projectRoot) return null;
  const resolved = validatePath(file, projectRoot);
  if (!resolved) return null;

  const style = detectDocStyle(file);

  // F13: Replace sequential existsSync/statSync/readFileSync calls on
  // `resolved` with a single fd-based approach. Each transition between
  // these calls is a TOCTOU window where a symlink could be swapped.
  // Using openSync + fstatSync + readFileSync on the same fd guarantees
  // all operations target the same inode (matching updateInlineDoc).
  let content: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
    content = fs.readFileSync(fd, 'utf-8');
  } catch (err: any) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      console.warn(`DocRel: extractDocstring failed for ${resolved}:`, err instanceof Error ? err.message : err);
    }
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }

  // Dispatch to language-specific extraction
  switch (style) {
    case 'python':
      return extractPythonDocstring(content, symbolName);
    case 'go':
      return extractGoDocstring(content, symbolName);
    case 'rust':
      return extractRustDocstring(content, symbolName);
    default:
      break; // JSDoc path below
  }

  // --- JSDoc (TypeScript / JavaScript) path ---
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
export function stripAllBlockComments(content: string): string {
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
    // Line comment — F7: Only treat // as a comment start when the
    // preceding character is whitespace, line-start, or a comment-safe
    // token. In JavaScript/TypeScript, `/` can start a regex literal
    // (e.g., `/foo/g` or `/https:\/\//.test(url)`). A `//` inside a
    // regex literal is NOT a comment. The heuristic: `//` at position 0
    // or preceded by whitespace/semicolon/brace is a comment; otherwise
    // it may be inside a regex literal.
    if (c === '/' && next === '/') {
      const prev = i > 0 ? line[i - 1] : ' ';
      if (i === 0 || prev === ' ' || prev === '\t' || prev === ';' ||
          prev === '{' || prev === '}' || prev === '(' || prev === ',' ||
          prev === '\n' || prev === '\r') {
        break; // rest of line is comment
      }
      // Otherwise, likely a regex literal — keep the slashes and continue
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
  oldDocstring: string,
  newSignature: string,
): string {
  // Generate a basic updated JSDoc/docstring based on the new signature.
  // Preserve user-written narrative content from the old docstring that falls
  // outside the @param/@returns blocks — this prevents auto_update from
  // silently destroying hand-written documentation (e.g., examples, notes).
  const params = extractParams(newSignature);
  const lines: string[] = [];
  let inParamBlock = false;
  let inReturnsBlock = false;

  // Extract user-written narrative lines from the old docstring.
  // Keep lines that are inside /** ... */ but NOT part of @param/@returns tags.
  if (oldDocstring.trim()) {
    const oldLines = oldDocstring.split('\n');
    for (const line of oldLines) {
      const trimmed = line.trim();
      // Skip the opening /** and closing */
      if (trimmed === '/**' || trimmed === '*/') continue;
      // Detect @param and @returns blocks
      if (/^\*\s*@param\b/.test(trimmed)) { inParamBlock = true; continue; }
      if (/^\*\s*@returns?\b/.test(trimmed)) { inReturnsBlock = true; continue; }
      if (/^\*\s*@\w+/.test(trimmed)) { inParamBlock = false; inReturnsBlock = false; continue; }
      if (inParamBlock || inReturnsBlock) continue;
      // Keep user-written narrative lines (including blank * lines between sections)
      if (trimmed.startsWith('*') || trimmed === '') {
        lines.push(line);
      }
    }
  }

  // If we have no narrative content from the old docstring, add a placeholder
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    lines.length = 0;
    lines.push('/**');
    lines.push(` * ${symbolName} — [auto-updated by DocRel]`);
  } else {
    // Insert the opening /** before the preserved narrative
    lines.unshift('/**');
  }

  // Append auto-generated @param entries
  for (const param of params) {
    lines.push(` * @param ${param.name} — ${param.type}`);
  }
  if (newSignature.includes('):') || kind === 'function') {
    const returnType = extractReturnType(newSignature);
    if (returnType) {
      lines.push(` * @returns {${returnType}}`);
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
    const trimmed = p.trim();
    // Find the first ':' outside brackets and strings to split name from type.
    // Using split(':') would break on colons inside complex types like
    // `options: { foo: string; bar: number }` or defaults like `name: string = "a:b"`.
    const colonIdx = findOuterColon(trimmed);
    const name = colonIdx >= 0 ? trimmed.slice(0, colonIdx).trim() : trimmed;
    const type = colonIdx >= 0 ? trimmed.slice(colonIdx + 1).trim() : 'any';
    return { name: name || 'arg', type: type || 'any' };
  }).filter((p) => p.name.length > 0);
}

/** Extract the return type annotation from a TypeScript function signature.
 *  Uses bracket-counting to correctly capture complex return types like
 *  `Promise<User>`, `{ bar: string }`, or `string | null` instead of
 *  truncating at the first whitespace-boundary. */
function extractReturnType(signature: string): string | null {
  // Find the closing parenthesis of the parameter list, then look for ':' after it
  const parenStart = signature.indexOf('(');
  if (parenStart < 0) return null;

  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < signature.length; i++) {
    if (signature[i] === '(') depth++;
    else if (signature[i] === ')') {
      depth--;
      if (depth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd < 0) return null;

  // Scan past '):' to find the start of the return type
  let i = parenEnd + 1;
  while (i < signature.length && signature[i] !== ':') i++;
  if (i >= signature.length) return null;
  i++; // skip ':'
  while (i < signature.length && (signature[i] === ' ' || signature[i] === '\t')) i++;
  if (i >= signature.length) return null;

  // Collect the return type with bracket counting to handle generics, unions,
  // and object types. Stop at comma, semicolon, or when all brackets close.
  let result = '';
  let bracketDepth = 0;
  for (; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') bracketDepth++;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') bracketDepth--;
    if (bracketDepth < 0) break;
    // At depth 0, stop at delimiters that signal the end of the return type
    if (bracketDepth === 0 && (ch === ',' || ch === ';' || ch === '\n' || ch === '\r')) break;
    result += ch;
  }
  const trimmed = result.trim();
  return trimmed || null;
}

/** Find the first colon that is outside brackets, braces, parens, and string
 *  literals. Used to split parameter name from type annotation without
 *  breaking on colons inside complex types or default values. */
function findOuterColon(str: string): number {
  let depth = 0;
  let inString: string | null = null;
  let nestDepth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (inString === '`' && ch === '$' && str[i + 1] === '{') { nestDepth++; continue; }
      if (inString === '`' && ch === '}' && nestDepth > 0) { nestDepth--; continue; }
      if (ch === inString && nestDepth === 0) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '>' || ch === ')' || ch === '}' || ch === ']') { depth--; continue; }
    if (ch === ':' && depth === 0) return i;
  }
  return -1;
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
