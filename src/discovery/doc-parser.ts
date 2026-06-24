// src/discovery/doc-parser.ts — Plugable doc parsers for extracting sections and code references

export interface CodeRef {
  symbolName: string;
  refType: 'backtick' | 'codeblock' | 'link' | 'heading';
  confidence: number;
  lineInDoc: number;
}

export interface ParsedDocSection {
  file: string;
  anchor: string;
  content: string;
  codeRefs: CodeRef[];
}

export interface DocParser {
  readonly name: string;
  readonly extensions: string[];
  parse(filePath: string, content: string): ParsedDocSection[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Match `symbolName(` patterns at the start of a backtick-wrapped
 *  function call. Used as a prefix detector; bracket counting handles
 *  the full expression including nested parens and backticks inside args. */
const FUNC_CALL_PREFIX_RE = /`([\w][\w\d_.]*\()/g;

/** F10: Extract a plain function call (not backtick-wrapped) using bracket
 *  counting to handle nested parentheses. Takes the position of the '('
 *  character and returns the full expression like 'foo(bar(baz))' or null. */
function extractPlainFuncCall(text: string, openParenIdx: number): string | null {
  // Walk backward from openParenIdx to find the function name start
  let nameEnd = openParenIdx;
  let nameStart = openParenIdx - 1;
  while (nameStart >= 0 && /[\w\d_.]/.test(text[nameStart])) nameStart--;
  nameStart++;
  if (nameStart >= nameEnd) return null;

  // Walk forward from openParenIdx to find matching close paren
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) {
        return text.slice(nameStart, i + 1);
      }
    }
  }
  return null;
}

/** Starting from a `symbolName(` match at position `openIdx` inside `text`,
 *  find the real closing paren and closing backtick using bracket counting
 *  with backtick-pair awareness. Returns the full expression including
 *  surrounding backticks, or null if parens/backticks are unmatched. */
function extractBacktickCall(text: string, openIdx: number): string | null {
  // openIdx points to the opening backtick. Walk forward tracking:
  // - parenDepth: when '(' opened and not closed
  // - inBacktick: whether we're inside a nested `...` pair
  let parenDepth = 0;
  let inBacktick = false;
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (inBacktick) {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { inBacktick = false; }
      continue;
    }
    if (ch === '`') {
      // Closing backtick of the outermost call — we're done
      if (parenDepth === 0) return text.slice(openIdx, i + 1);
      // Otherwise it's a nested backtick start
      inBacktick = true;
      continue;
    }
    if (ch === '(') { parenDepth++; }
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        // Scan ahead to find the closing backtick (skipping whitespace)
        let j = i + 1;
        while (j < text.length && text[j] !== '`') {
          if (text[j] === '(') parenDepth++;
          else if (text[j] === ')') parenDepth--;
          j++;
        }
        if (j < text.length && parenDepth === 0) {
          return text.slice(openIdx, j + 1);
        }
        // Didn't find closing backtick — keep going
      }
    }
  }
  return null;
}

/** Detect backtick-wrapped symbol names like `login`, `AuthService.login`. */
const BACKTICK_SYMBOL_RE = /`([\w][\w\d_.]+)`/g;

/** Detect simple function-like identifiers (standalone, not in backticks).
 *  Uses [^)]* for speed in code blocks and inline text.
 *  For heading extraction where nested parens matter, use extractPlainFuncCall. */
const PLAIN_FUNC_RE = /\b([\w][\w\d_.]+\([^)]*\))/g;
/** Prefix detector for bracket-counting plain function call extraction. */
const PLAIN_FUNC_PREFIX_RE = /\b([\w][\w\d_.]*)\(/g;

/** Extract symbol names from heading text by splitting on common separators. */
function extractSymbolsFromHeading(heading: string, lineInDoc: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();

  // Backtick symbols in heading
  for (const m of heading.matchAll(BACKTICK_SYMBOL_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      refs.push({ symbolName: name, refType: 'heading', confidence: 0.7, lineInDoc });
    }
  }

  // Plain function calls in heading — F10: use bracket counting via
  // extractPlainFuncCall instead of regex [^)]* to handle nested parens.
  for (const m of heading.matchAll(PLAIN_FUNC_PREFIX_RE)) {
    const call = extractPlainFuncCall(heading, m.index + m[0].length - 1);
    if (!call) continue;
    if (!seen.has(call)) {
      seen.add(call);
      refs.push({ symbolName: call, refType: 'heading', confidence: 0.5, lineInDoc });
    }
  }

  return refs;
}

/** Extract code refs from body text (excluding code blocks already captured). */
function extractBodyRefs(body: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNum = baseLine + i + 1; // 1-based line number

    // Backtick `funcName(...)` — use bracket counting with backtick-pair
    // awareness to handle nested parens and backticks inside arguments.
    for (const m of lines[i].matchAll(FUNC_CALL_PREFIX_RE)) {
      const full = extractBacktickCall(lines[i], m.index);
      if (full) {
        // full is `...` — strip surrounding backticks for the symbol name
        const inner = full.slice(1, -1); // remove outer backticks
        const name = inner; // already bracket-counted by extractBacktickCall
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'backtick', confidence: 0.85, lineInDoc: lineNum });
        }
      }
    }

    // Backtick `symbolName` (no parens)
    for (const m of lines[i].matchAll(BACKTICK_SYMBOL_RE)) {
      const name = m[1];
      if (!name.includes('(') && !seen.has(name)) {
        seen.add(name);
        refs.push({ symbolName: name, refType: 'backtick', confidence: 0.6, lineInDoc: lineNum });
      }
    }
  }

  return refs;
}

// ── MarkdownParser ─────────────────────────────────────────────────────────

export class MarkdownParser implements DocParser {
  readonly name = 'markdown';
  readonly extensions = ['.md', '.mdx'];

  parse(filePath: string, content: string): ParsedDocSection[] {
    const MAX_DOC_LINES = 100_000;
    // Count newlines up to MAX_DOC_LINES+1 before calling split('\n') to
    // prevent a massive array allocation from pathological input (e.g., a
    // 10 MB file of 2-char lines). The content is already bounded at 10 MB
    // by doc-scanner.ts, but without this guard the split creates ~5 M
    // string objects before the line-count check below can reject them.
    // Pattern matches the fix applied to builtin.ts (MAX_LINES=100K),
    // engine.ts, standalone.ts, review.ts, and inline.ts in rounds 5/9.
    let newlineCount = 1;
    for (let i = 0; i < content.length && newlineCount <= MAX_DOC_LINES; i++) {
      if (content[i] === '\n') newlineCount++;
    }
    if (newlineCount > MAX_DOC_LINES) {
      console.warn(`DocRelay: MarkdownParser: file has ${newlineCount} lines, exceeding limit of ${MAX_DOC_LINES} — skipping`);
      return [];
    }
    const lines = content.split('\n');
    const sections: ParsedDocSection[] = [];

    // Find all heading positions, skipping headings inside fenced code blocks.
    // Uses state-machine fence tracking to prevent # lines inside ``` or ~~~
    // blocks from creating spurious doc sections (e.g., "# This is a comment"
    // inside a code example). Opening fences may have a language identifier
    // (e.g., ```typescript); closing fences must be the bare token.
    const headings: { level: number; line: number; text: string }[] = [];
    let inCodeBlock = false;
    let fenceToken = '';
    for (let i = 0; i < lines.length; i++) {
      // Match fences: ```, ````, ~~~, ~~~~ etc. with optional language
      // identifier after the fence characters.
      const fenceMatch = lines[i].match(/^(```+|~~~+)(.*)/);
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
      const m = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (m) {
        headings.push({ level: m[1].length, line: i, text: m[2].trim() });
      }
    }

    if (headings.length === 0 && content.trim()) {
      // Whole doc as a single section
      sections.push(this.makeSection(filePath, '', content, 0));
      return sections;
    }

    // Capture preamble content (before the first heading) as a synthetic
    // "top" section. Without this, any text, code references, or symbol
    // mentions before the first heading are silently dropped — they are
    // never indexed, never auto-linked, and can never appear in mappings.
    if (headings.length > 0 && headings[0].line > 0) {
      const preambleLines = lines.slice(0, headings[0].line).join('\n');
      if (preambleLines.trim()) {
        sections.push(this.makeSection(filePath, '', preambleLines, 0));
      }
    }

    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].line;
      const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
      const sectionLines = lines.slice(start + 1, end).join('\n');
      const anchor = headings[i].text;

      let codeRefs = extractBodyRefs(sectionLines, start + 1);
      codeRefs = codeRefs.concat(extractSymbolsFromHeading(anchor, start + 1));

      // Extract code refs from fenced code blocks
      const codeBlockRefs = extractCodeBlockRefs(sectionLines, start + 1);
      codeRefs = codeRefs.concat(codeBlockRefs);

      // Extract refs from links: [text](url)
      const linkRefs = extractMdLinkRefs(sectionLines, start + 1);
      codeRefs = codeRefs.concat(linkRefs);

      sections.push({
        file: filePath,
        anchor,
        content: `${lines[start]}\n${sectionLines}`,
        codeRefs,
      });
    }

    return sections;
  }

  private makeSection(file: string, anchor: string, content: string, line: number): ParsedDocSection {
    let codeRefs = extractBodyRefs(content, line);
    codeRefs = codeRefs.concat(extractCodeBlockRefs(content, line));
    codeRefs = codeRefs.concat(extractMdLinkRefs(content, line));
    return { file, anchor, content, codeRefs };
  }
}

function extractCodeBlockRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  let inBlock = false;
  let fenceToken = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match fences: ```, ````, ~~~, ~~~~ etc. with optional language
    // identifier after the fence characters (e.g., ```typescript).
    // Capture group 1: fence chars, group 2: everything after.
    const fenceMatch = line.match(/^(```+|~~~+)(.*)/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      const afterFence = fenceMatch[2].trim();
      if (!inBlock) {
        // Opening fence — language identifier is allowed after the fence
        inBlock = true;
        fenceToken = token;
        continue;
      }
      // Closing fence — same character type, at least as long, and
      // nothing but whitespace after the fence characters. This
      // prevents ```` ```javascript ```` from closing a `````` block.
      if (token.startsWith(fenceToken[0]) && token.length >= fenceToken.length && afterFence === '') {
        inBlock = false;
        fenceToken = '';
      }
      continue;
    }
    if (inBlock) {
      // Look for function calls inside code blocks
      for (const m of line.matchAll(PLAIN_FUNC_RE)) {
        const name = m[1];
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'codeblock', confidence: 0.9, lineInDoc: baseLine + i + 1 });
        }
      }
    }
  }
  return refs;
}

function extractMdLinkRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // [text](url)
    for (const m of lines[i].matchAll(/\[([^\]]+)\]\([^)]+\)/g)) {
      const text = m[1];
      // Check if link text contains function names
      for (const fm of text.matchAll(PLAIN_FUNC_RE)) {
        const name = fm[1];
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'link', confidence: 0.5, lineInDoc: baseLine + i + 1 });
        }
      }
    }
  }
  return refs;
}

// ── RstParser ──────────────────────────────────────────────────────────────

export class RstParser implements DocParser {
  readonly name = 'rst';
  readonly extensions = ['.rst'];

  parse(filePath: string, content: string): ParsedDocSection[] {
    const MAX_DOC_LINES = 100_000;
    // Pre-split line count guard — see MarkdownParser.parse() for rationale.
    let newlineCount = 1;
    for (let i = 0; i < content.length && newlineCount <= MAX_DOC_LINES; i++) {
      if (content[i] === '\n') newlineCount++;
    }
    if (newlineCount > MAX_DOC_LINES) {
      console.warn(`DocRelay: RstParser: file has ${newlineCount} lines, exceeding limit of ${MAX_DOC_LINES} — skipping`);
      return [];
    }
    const lines = content.split('\n');
    const sections: ParsedDocSection[] = [];

    // Find heading positions: underlined headings (line followed by === --- ~~~ ^^^ etc.)
    const headings: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const nextLine = lines[i + 1];
      if (nextLine.length > 0 && /^[=\-~^"']{3,}$/.test(nextLine)) {
        headings.push({ line: i, text: lines[i].trim() });
      }
    }

    if (headings.length === 0 && content.trim()) {
      sections.push(this.makeSection(filePath, '', content, 0));
      return sections;
    }

    // Capture preamble content before the first heading as a "top" section.
    if (headings.length > 0 && headings[0].line > 0) {
      const preambleLines = lines.slice(0, headings[0].line).join('\n');
      if (preambleLines.trim()) {
        sections.push(this.makeSection(filePath, '', preambleLines, 0));
      }
    }

    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].line;
      // Each heading consumes 2 lines (text + underline), skip past them
      const contentStart = start + 2;
      const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
      const sectionLines = lines.slice(contentStart, end).join('\n');
      const anchor = headings[i].text;

      let codeRefs = extractBodyRefs(sectionLines, contentStart);
      codeRefs = codeRefs.concat(extractSymbolsFromHeading(anchor, start + 1));

      // RST code blocks: .. code:: language
      const codeBlockRefs = extractRstCodeBlockRefs(sectionLines, contentStart);
      codeRefs = codeRefs.concat(codeBlockRefs);

      // RST role references: :func:`name`, :meth:`name`, :class:`name`
      const roleRefs = extractRstRoleRefs(sectionLines, contentStart);
      codeRefs = codeRefs.concat(roleRefs);

      sections.push({
        file: filePath,
        anchor,
        content: `${lines[start]}\n${lines[start + 1] ?? ''}\n${sectionLines}`,
        codeRefs,
      });
    }

    return sections;
  }

  private makeSection(file: string, anchor: string, content: string, line: number): ParsedDocSection {
    let codeRefs = extractBodyRefs(content, line);
    codeRefs = codeRefs.concat(extractRstCodeBlockRefs(content, line));
    codeRefs = codeRefs.concat(extractRstRoleRefs(content, line));
    return { file, anchor, content, codeRefs };
  }
}

function extractRstCodeBlockRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\.\.\s+code::/i.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.trim() === '' && i + 1 < lines.length && !lines[i + 1].startsWith(' ')) {
      inBlock = false;
      continue;
    }
    if (inBlock) {
      for (const m of line.matchAll(PLAIN_FUNC_RE)) {
        const name = m[1];
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'codeblock', confidence: 0.9, lineInDoc: baseLine + i + 1 });
        }
      }
    }
  }
  return refs;
}

function extractRstRoleRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // :func:`name`, :meth:`name`, :class:`name`, :mod:`name`
    for (const m of lines[i].matchAll(/:(?:func|meth|class|mod|attr|exc|data|const|obj):`([^`]+)`/g)) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        refs.push({ symbolName: name, refType: 'link', confidence: 0.95, lineInDoc: baseLine + i + 1 });
      }
    }
  }
  return refs;
}

// ── AsciidocParser ─────────────────────────────────────────────────────────

export class AsciidocParser implements DocParser {
  readonly name = 'asciidoc';
  readonly extensions = ['.adoc', '.asciidoc'];

  parse(filePath: string, content: string): ParsedDocSection[] {
    const MAX_DOC_LINES = 100_000;
    // Pre-split line count guard — see MarkdownParser.parse() for rationale.
    let newlineCount = 1;
    for (let i = 0; i < content.length && newlineCount <= MAX_DOC_LINES; i++) {
      if (content[i] === '\n') newlineCount++;
    }
    if (newlineCount > MAX_DOC_LINES) {
      console.warn(`DocRelay: AsciidocParser: file has ${newlineCount} lines, exceeding limit of ${MAX_DOC_LINES} — skipping`);
      return [];
    }
    const lines = content.split('\n');
    const sections: ParsedDocSection[] = [];

    // Find heading positions: == or === headings
    const headings: { level: number; line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(={2,4})\s+(.+)/);
      if (m) {
        headings.push({ level: m[1].length, line: i, text: m[2].trim() });
      }
    }

    if (headings.length === 0 && content.trim()) {
      sections.push(this.makeSection(filePath, '', content, 0));
      return sections;
    }

    // Capture preamble content before the first heading as a "top" section.
    if (headings.length > 0 && headings[0].line > 0) {
      const preambleLines = lines.slice(0, headings[0].line).join('\n');
      if (preambleLines.trim()) {
        sections.push(this.makeSection(filePath, '', preambleLines, 0));
      }
    }

    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].line;
      const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
      const sectionLines = lines.slice(start + 1, end).join('\n');
      const anchor = headings[i].text;

      let codeRefs = extractBodyRefs(sectionLines, start + 1);
      codeRefs = codeRefs.concat(extractSymbolsFromHeading(anchor, start + 1));

      // Asciidoc code blocks: ---- or ....
      const codeBlockRefs = extractAsciidocCodeBlockRefs(sectionLines, start + 1);
      codeRefs = codeRefs.concat(codeBlockRefs);

      // Asciidoc links: link:xxx[] and xref:xxx[]
      const linkRefs = extractAsciidocLinkRefs(sectionLines, start + 1);
      codeRefs = codeRefs.concat(linkRefs);

      sections.push({
        file: filePath,
        anchor,
        content: `${lines[start]}\n${sectionLines}`,
        codeRefs,
      });
    }

    return sections;
  }

  private makeSection(file: string, anchor: string, content: string, line: number): ParsedDocSection {
    let codeRefs = extractBodyRefs(content, line);
    codeRefs = codeRefs.concat(extractAsciidocCodeBlockRefs(content, line));
    codeRefs = codeRefs.concat(extractAsciidocLinkRefs(content, line));
    return { file, anchor, content, codeRefs };
  }
}

function extractAsciidocCodeBlockRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Asciidoc listing/delimiter blocks start with ---- or ....
    if (/^[-.]{4,}$/.test(line.trim())) {
      if (!inBlock) {
        inBlock = true;
      } else {
        inBlock = false;
      }
      continue;
    }
    if (inBlock) {
      for (const m of line.matchAll(PLAIN_FUNC_RE)) {
        const name = m[1];
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'codeblock', confidence: 0.9, lineInDoc: baseLine + i + 1 });
        }
      }
    }
  }
  return refs;
}

function extractAsciidocLinkRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // link:xxx[...] and xref:xxx[...]
    for (const m of lines[i].matchAll(/(?:link|xref):([^\[]+)\[/g)) {
      const target = m[1].trim();
      if (target && !seen.has(target)) {
        seen.add(target);
        refs.push({ symbolName: target, refType: 'link', confidence: 0.4, lineInDoc: baseLine + i + 1 });
      }
    }
  }
  return refs;
}

// ── HtmlParser ─────────────────────────────────────────────────────────────

export class HtmlParser implements DocParser {
  readonly name = 'html';
  readonly extensions = ['.html', '.htm'];

  parse(filePath: string, content: string): ParsedDocSection[] {
    // HtmlParser processes the full HTML without splitting by line —
    // use a 10MB content limit for defense-in-depth (doc-scanner already
    // applies a 10MB file-size limit).
    const MAX_HTML_SIZE = 10 * 1024 * 1024;
    if (content.length > MAX_HTML_SIZE) {
      console.warn(`DocRelay: HtmlParser: content exceeds ${MAX_HTML_SIZE} bytes — skipping`);
      return [];
    }
    const sections: ParsedDocSection[] = [];

    // Find h1-h6 heading positions
    const headingRe = /<h([1-6])[^>]*>(.+?)<\/h\1>/gi;
    const matches: { index: number; endIndex: number; level: number; text: string }[] = [];

    // F21: Cap heading match count to prevent memory exhaustion from
    // crafted HTML files with millions of <h1> tags within the 10MB limit.
    const MAX_HEADINGS = 50000;

    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(content)) !== null) {
      if (matches.length >= MAX_HEADINGS) {
        console.warn(`DocRelay: HtmlParser reached limit of ${MAX_HEADINGS} headings — truncating`);
        break;
      }
      matches.push({
        index: m.index,
        endIndex: m.index + m[0].length,
        level: parseInt(m[1], 10),
        text: stripHtmlTags(m[2]).trim(),
      });
    }

    if (matches.length === 0 && content.trim()) {
      sections.push(this.makeSection(filePath, '', content));
      return sections;
    }

    // Capture preamble content (before the first heading tag) as a "top" section.
    if (matches.length > 0 && matches[0].index > 0) {
      const preambleContent = content.substring(0, matches[0].index).trim();
      if (preambleContent) {
        sections.push(this.makeSection(filePath, '', content.substring(0, matches[0].index)));
      }
    }

    // F26 (round 14): Add a line-count guard before the heading loop to
    // prevent O(n) line array allocations on pathological 10 MB HTML files
    // with millions of short lines. The other three parsers (Markdown, RST,
    // Asciidoc) all have MAX_DOC_LINES=100K guards added in round 10; the
    // HTML parser was missed because it does not split the entire document
    // upfront — but lineInDoc computation at line 680 still calls .split('\\n')
    // on substrings up to 10 MB for each of up to 50000 headings.
    const MAX_HTML_LINES = 100_000;
    let htmlLineCount = 1;
    for (let li = 0; li < content.length && htmlLineCount <= MAX_HTML_LINES; li++) {
      if (content[li] === '\n') htmlLineCount++;
    }
    if (htmlLineCount > MAX_HTML_LINES) {
      console.warn(`DocRelay: HtmlParser: content has ${htmlLineCount} lines, exceeding ${MAX_HTML_LINES} — skipping`);
      return [];
    }
    // Pre-compute line-start offsets for O(1) line-number lookups, avoiding
    // the repeated O(n) .split('\\n') per heading that could allocate millions
    // of string objects on pathological input.
    const lineStarts: number[] = [0];
    for (let li = 0; li < content.length; li++) {
      if (content[li] === '\n') lineStarts.push(li + 1);
    }

    for (let i = 0; i < matches.length; i++) {
      const startIdx = matches[i].index;
      const endIdx = i + 1 < matches.length ? matches[i + 1].index : content.length;
      const sectionContent = content.substring(startIdx, endIdx);

      // Approximate line number — use binary search on pre-computed offsets
      // instead of content.substring(0, startIdx).split('\\n').length which
      // allocates a full array per heading.
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineStarts[mid] <= startIdx) lo = mid;
        else hi = mid - 1;
      }
      const lineInDoc = lo + 1;

      const codeRefs = extractHtmlCodeRefs(sectionContent, lineInDoc);
      const headingRefs = extractSymbolsFromHeading(matches[i].text, lineInDoc);
      const allRefs = dedupCodeRefs(codeRefs.concat(headingRefs));

      sections.push({
        file: filePath,
        anchor: matches[i].text,
        content: sectionContent,
        codeRefs: allRefs,
      });
    }

    return sections;
  }

  private makeSection(file: string, anchor: string, content: string): ParsedDocSection {
    const codeRefs = extractHtmlCodeRefs(content, 1);
    return { file, anchor, content, codeRefs };
  }
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

const MAX_CODE_REFS_PER_FILE = 10_000;

function extractHtmlCodeRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  // HtmlParser processes raw HTML without splitting by line, so a single section
  // between two heading tags can contain nearly the entire 10 MB file. Count
  // newlines before split to prevent a multi-million-element array allocation.
  const MAX_HTML_CODE_LINES = 100_000;
  let newlineCount = 1;
  for (let i = 0; i < text.length && newlineCount <= MAX_HTML_CODE_LINES; i++) {
    if (text[i] === '\n') newlineCount++;
  }
  if (newlineCount > MAX_HTML_CODE_LINES) {
    console.warn(`DocRelay: extractHtmlCodeRefs: content has ${newlineCount} lines, exceeding ${MAX_HTML_CODE_LINES} — skipping`);
    return [];
  }
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Cap total refs per section to prevent memory exhaustion from crafted
    // input (e.g., 10 MB file consisting entirely of `func()` repeats).
    if (refs.length >= MAX_CODE_REFS_PER_FILE) {
      console.warn(`DocRelay: extractHtmlCodeRefs reached limit of ${MAX_CODE_REFS_PER_FILE} refs — stopping extraction`);
      break;
    }
    const lineNum = baseLine + i;

    // <code> elements
    for (const m of lines[i].matchAll(/<code[^>]*>(.+?)<\/code>/g)) {
      const code = stripHtmlTags(m[1]);
      for (const fm of code.matchAll(PLAIN_FUNC_RE)) {
        const name = fm[1];
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'backtick', confidence: 0.85, lineInDoc: lineNum });
        }
      }
      // Also capture bare symbols inside <code> tags
      for (const sm of code.matchAll(/\b([\w][\w\d_.]+)\b/g)) {
        const name = sm[1];
        if (!name.includes('(') && !seen.has(name) && name.length > 1) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'backtick', confidence: 0.6, lineInDoc: lineNum });
        }
      }
    }

    // <pre> blocks
    if (/<pre[^>]*>/i.test(lines[i])) {
      // Find closing </pre> and extract content
      const preContent = extractPreContent(lines, i);
      for (const pc of preContent) {
        for (const fm of pc.matchAll(PLAIN_FUNC_RE)) {
          const name = fm[1];
          if (!seen.has(name)) {
            seen.add(name);
            refs.push({ symbolName: name, refType: 'codeblock', confidence: 0.9, lineInDoc: lineNum });
          }
        }
      }
    }

    // <a> links
    for (const m of lines[i].matchAll(/<a[^>]*?href=["']([^"']+)["'][^>]*>(.+?)<\/a>/g)) {
      const linkText = stripHtmlTags(m[2]);
      for (const fm of linkText.matchAll(PLAIN_FUNC_RE)) {
        const name = fm[1];
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ symbolName: name, refType: 'link', confidence: 0.5, lineInDoc: lineNum });
        }
      }
    }

    // Backtick-wrapped function calls in text
    for (const m of lines[i].matchAll(FUNC_CALL_PREFIX_RE)) {
      const full = extractBacktickCall(lines[i], m.index);
      if (full) {
        const inner = full.slice(1, -1);
        if (!seen.has(inner)) {
          seen.add(inner);
          refs.push({ symbolName: inner, refType: 'backtick', confidence: 0.85, lineInDoc: lineNum });
        }
      }
    }
  }

  return refs;
}

const MAX_PRE_LINES = 5000;

function extractPreContent(lines: string[], startIdx: number): string[] {
  const content: string[] = [];
  for (let i = startIdx + 1; i < lines.length && content.length < MAX_PRE_LINES; i++) {
    if (/<\/pre>/i.test(lines[i])) break;
    content.push(lines[i]);
  }
  if (content.length >= MAX_PRE_LINES) {
    console.warn(`DocRelay: extractPreContent reached limit of ${MAX_PRE_LINES} lines — content may be truncated`);
  }
  return content;
}

// ── Factory ────────────────────────────────────────────────────────────────

const PARSERS: DocParser[] = [
  new MarkdownParser(),
  new RstParser(),
  new AsciidocParser(),
  new HtmlParser(),
];

export function getParser(extension: string): DocParser | null {
  const normalized = extension.toLowerCase();
  for (const parser of PARSERS) {
    if (parser.extensions.includes(normalized)) {
      return parser;
    }
  }
  return null;
}

/** All registered parsers (for iteration). */
export function getAllParsers(): readonly DocParser[] {
  return PARSERS;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function dedupCodeRefs(refs: CodeRef[]): CodeRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.symbolName}:${r.refType}:${r.lineInDoc}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
