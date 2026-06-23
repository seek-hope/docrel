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

/** Detect `funcName(...)`, `funcName()`, or `ClassName.method(...)` patterns. */
const FUNC_CALL_RE = /`([\w][\w\d_.]*\([^)]*\))`/g;

/** Detect backtick-wrapped symbol names like `login`, `AuthService.login`. */
const BACKTICK_SYMBOL_RE = /`([\w][\w\d_.]+)`/g;

/** Detect function-like identifiers in plain text (standalone, not in backticks). */
const PLAIN_FUNC_RE = /\b([\w][\w\d_.]+\([^)]*\))/g;

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

  // Plain function calls in heading
  for (const m of heading.matchAll(PLAIN_FUNC_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      refs.push({ symbolName: name, refType: 'heading', confidence: 0.5, lineInDoc });
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

    // Backtick `funcName(...)`
    for (const m of lines[i].matchAll(FUNC_CALL_RE)) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        refs.push({ symbolName: name, refType: 'backtick', confidence: 0.85, lineInDoc: lineNum });
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
    const lines = content.split('\n');
    const sections: ParsedDocSection[] = [];

    // Find all heading positions
    const headings: { level: number; line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{2,4})\s+(.+)/);
      if (m) {
        headings.push({ level: m[1].length, line: i, text: m[2].trim() });
      }
    }

    if (headings.length === 0 && content.trim()) {
      // Whole doc as a single section
      sections.push(this.makeSection(filePath, '', content, 0));
      return sections;
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
  let blockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (!inBlock) {
        inBlock = true;
        blockLang = fenceMatch[1] || '';
      } else {
        inBlock = false;
        blockLang = '';
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
    const sections: ParsedDocSection[] = [];

    // Find h1-h6 heading positions
    const headingRe = /<h([1-6])[^>]*>(.+?)<\/h\1>/gi;
    const matches: { index: number; endIndex: number; level: number; text: string }[] = [];

    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(content)) !== null) {
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

    for (let i = 0; i < matches.length; i++) {
      const startIdx = matches[i].index;
      const endIdx = i + 1 < matches.length ? matches[i + 1].index : content.length;
      const sectionContent = content.substring(startIdx, endIdx);

      // Approximate line number
      const lineInDoc = content.substring(0, startIdx).split('\n').length;

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

function extractHtmlCodeRefs(text: string, baseLine: number): CodeRef[] {
  const refs: CodeRef[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
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

    // Backtick-wrapped symbols in text
    for (const m of lines[i].matchAll(FUNC_CALL_RE)) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        refs.push({ symbolName: name, refType: 'backtick', confidence: 0.85, lineInDoc: lineNum });
      }
    }
  }

  return refs;
}

function extractPreContent(lines: string[], startIdx: number): string[] {
  const content: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/<\/pre>/i.test(lines[i])) break;
    content.push(lines[i]);
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
