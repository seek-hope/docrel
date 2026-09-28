import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MarkdownParser,
  RstParser,
  AsciidocParser,
  HtmlParser,
  getParser,
  getAllParsers,
  type DocParser,
  type ParsedDocSection,
} from '../../src/discovery/doc-parser.js';

function collectCodeRefs(sections: ParsedDocSection[]): Array<{ name: string; type: string }> {
  const refs: Array<{ name: string; type: string }> = [];
  for (const s of sections) {
    for (const r of s.codeRefs) {
      refs.push({ name: r.symbolName, type: r.refType });
    }
  }
  return refs;
}

// ── MarkdownParser ─────────────────────────────────────────────────────────

describe('MarkdownParser', () => {
  it('returns empty array for empty content', () => {
    const p = new MarkdownParser();
    expect(p.parse('test.md', '')).toEqual([]);
    expect(p.parse('test.md', '\n\n\n')).toEqual([]);
  });

  it('splits markdown by ## and ### headings', () => {
    const p = new MarkdownParser();
    const content = [
      '## Introduction',
      'Some intro text.',
      '',
      '### Getting Started',
      'Setup instructions here.',
      '',
      '## API Reference',
      'API docs here.',
    ].join('\n');

    const sections = p.parse('docs/guide.md', content);
    expect(sections).toHaveLength(3);
    expect(sections[0].anchor).toBe('Introduction');
    expect(sections[1].anchor).toBe('Getting Started');
    expect(sections[2].anchor).toBe('API Reference');
  });

  it('returns whole doc as single section when no headings', () => {
    const p = new MarkdownParser();
    const content = 'This is a file without headings.\nJust plain text.';
    const sections = p.parse('docs/plain.md', content);

    expect(sections).toHaveLength(1);
    expect(sections[0].anchor).toBe('');
    expect(sections[0].file).toBe('docs/plain.md');
  });

  it('extracts backtick code refs with parentheses', () => {
    const p = new MarkdownParser();
    const content = [
      '## Functions',
      'Use `login()` to authenticate users.',
      '',
      'Also see `AuthService.register(user)` for registration.',
    ].join('\n');

    const sections = p.parse('docs/funcs.md', content);
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login()', type: 'backtick' },
        { name: 'AuthService.register(user)', type: 'backtick' },
      ]),
    );
  });

  it('extracts backtick symbol names without parentheses', () => {
    const p = new MarkdownParser();
    const content = [
      '## Configuration',
      'Set `API_KEY` and `maxRetries` before calling `init`.',
    ].join('\n');

    const sections = p.parse('docs/config.md', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'backtick');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'API_KEY', type: 'backtick' },
        { name: 'maxRetries', type: 'backtick' },
        { name: 'init', type: 'backtick' },
      ]),
    );
  });

  it('extracts function refs from fenced code blocks', () => {
    const p = new MarkdownParser();
    const content = [
      '## Example',
      '```typescript',
      'const result = authenticate(user);',
      'validateToken(token);',
      '```',
    ].join('\n');

    const sections = p.parse('docs/example.md', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'codeblock');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'authenticate(user)', type: 'codeblock' },
        { name: 'validateToken(token)', type: 'codeblock' },
      ]),
    );
  });

  it('extracts references from link text', () => {
    const p = new MarkdownParser();
    const content = [
      '## See Also',
      'Check out [login() implementation](../src/auth.ts) for details.',
    ].join('\n');

    const sections = p.parse('docs/links.md', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'link');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login()', type: 'link' },
      ]),
    );
  });

  it('extracts refs from heading text', () => {
    const p = new MarkdownParser();
    const content = [
      '## The `authenticate()` function',
      'Docs here.',
    ].join('\n');

    const sections = p.parse('docs/heading.md', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'heading');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'authenticate()', type: 'heading' },
      ]),
    );
  });

  it('handles .mdx extension', () => {
    const p = new MarkdownParser();
    const content = [
      '## Components',
      'Use `<Button />` with the `handleClick()` callback.',
    ].join('\n');

    const sections = p.parse('docs/components.mdx', content);
    expect(sections).toHaveLength(1);
    expect(sections[0].anchor).toBe('Components');
  });

  it('sets confidence values on code refs', () => {
    const p = new MarkdownParser();
    const content = '## Test\nUse `myFunc()` in code.\n```ts\notherFunc(x);\n```\n';
    const sections = p.parse('test.md', content);
    const allRefs = sections.flatMap((s) => s.codeRefs);

    for (const ref of allRefs) {
      expect(ref.confidence).toBeGreaterThanOrEqual(0);
      expect(ref.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ── RstParser ──────────────────────────────────────────────────────────────

describe('RstParser', () => {
  it('splits by underlined headings', () => {
    const p = new RstParser();
    const content = [
      'Introduction',
      '============',
      'Some intro text.',
      '',
      'Getting Started',
      '---------------',
      'Setup instructions.',
      '',
      'API Reference',
      '==============',
      'API docs.',
    ].join('\n');

    const sections = p.parse('docs/guide.rst', content);
    expect(sections).toHaveLength(3);
    expect(sections[0].anchor).toBe('Introduction');
    expect(sections[1].anchor).toBe('Getting Started');
    expect(sections[2].anchor).toBe('API Reference');
  });

  it('extracts cross-reference roles', () => {
    const p = new RstParser();
    const content = [
      'Functions',
      '=========',
      'Call :func:`login` to authenticate.',
      'Use :meth:`UserService.create` for registration.',
      'See :class:`AuthConfig` for options.',
    ].join('\n');

    const sections = p.parse('docs/roles.rst', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'link');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login', type: 'link' },
        { name: 'UserService.create', type: 'link' },
        { name: 'AuthConfig', type: 'link' },
      ]),
    );
  });

  it('extracts refs from code blocks', () => {
    const p = new RstParser();
    const content = [
      'Example',
      '=======',
      '.. code:: python',
      '',
      '   result = authenticate(user)',
      '   validate(result)',
    ].join('\n');

    const sections = p.parse('docs/code.rst', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'codeblock');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'authenticate(user)', type: 'codeblock' },
        { name: 'validate(result)', type: 'codeblock' },
      ]),
    );
  });

  it('handles backtick-wrapped function refs in body', () => {
    const p = new RstParser();
    const content = [
      'Usage',
      '=====',
      'Call ``login()`` to start a session.',
    ].join('\n');

    const sections = p.parse('docs/usage.rst', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'backtick');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login()', type: 'backtick' },
      ]),
    );
  });
});

// ── AsciidocParser ─────────────────────────────────────────────────────────

describe('AsciidocParser', () => {
  it('splits by == and === headings', () => {
    const p = new AsciidocParser();
    const content = [
      '== Introduction',
      'Intro text.',
      '',
      '=== Setup',
      'Setup instructions.',
      '',
      '== API Reference',
      'API docs.',
    ].join('\n');

    const sections = p.parse('docs/guide.adoc', content);
    expect(sections).toHaveLength(3);
    expect(sections[0].anchor).toBe('Introduction');
    expect(sections[1].anchor).toBe('Setup');
    expect(sections[2].anchor).toBe('API Reference');
  });

  it('extracts refs from delimited code blocks', () => {
    const p = new AsciidocParser();
    const content = [
      '== Example',
      '[source,python]',
      '----',
      'result = login(user, password)',
      'processResult(result)',
      '----',
    ].join('\n');

    const sections = p.parse('docs/example.adoc', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'codeblock');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login(user, password)', type: 'codeblock' },
        { name: 'processResult(result)', type: 'codeblock' },
      ]),
    );
  });

  it('extracts link/xref targets', () => {
    const p = new AsciidocParser();
    const content = [
      '== Related',
      'See link:login[Login Function] for details.',
      'Also xref:register[Registration].',
    ].join('\n');

    const sections = p.parse('docs/links.adoc', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'link');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login', type: 'link' },
        { name: 'register', type: 'link' },
      ]),
    );
  });

  it('extracts backtick code refs in body', () => {
    const p = new AsciidocParser();
    const content = [
      '== Functions',
      'Call `authenticate()` before using `fetchData()`.',
    ].join('\n');

    const sections = p.parse('docs/funcs.adoc', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'backtick');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'authenticate()', type: 'backtick' },
        { name: 'fetchData()', type: 'backtick' },
      ]),
    );
  });

  it('handles .asciidoc extension', () => {
    const p = new AsciidocParser();
    const content = [
      '== Section',
      'Content.',
    ].join('\n');

    const sections = p.parse('docs/guide.asciidoc', content);
    expect(sections).toHaveLength(1);
    expect(sections[0].anchor).toBe('Section');
  });
});

// ── HtmlParser ─────────────────────────────────────────────────────────────

describe('HtmlParser', () => {
  it('splits by h1-h6 tags', () => {
    const p = new HtmlParser();
    const content = [
      '<h2>Introduction</h2>',
      '<p>Intro text.</p>',
      '',
      '<h3>Getting Started</h3>',
      '<p>Setup instructions.</p>',
      '',
      '<h2>API Reference</h2>',
      '<p>API docs.</p>',
    ].join('\n');

    const sections = p.parse('docs/guide.html', content);
    expect(sections).toHaveLength(3);
    expect(sections[0].anchor).toBe('Introduction');
    expect(sections[1].anchor).toBe('Getting Started');
    expect(sections[2].anchor).toBe('API Reference');
  });

  it('extracts refs from <code> elements', () => {
    const p = new HtmlParser();
    const content = [
      '<h2>Functions</h2>',
      '<p>Call <code>login()</code> to authenticate.</p>',
      '<p>Use <code>AuthService.register(user)</code> for accounts.</p>',
    ].join('\n');

    const sections = p.parse('docs/funcs.html', content);
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login()', type: 'backtick' },
        { name: 'AuthService.register(user)', type: 'backtick' },
      ]),
    );
  });

  it('extracts refs from <pre> blocks', () => {
    const p = new HtmlParser();
    const content = [
      '<h2>Example</h2>',
      '<pre><code>',
      'const result = authenticate(token);',
      'validate(result);',
      '</code></pre>',
    ].join('\n');

    const sections = p.parse('docs/example.html', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'codeblock');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'authenticate(token)', type: 'codeblock' },
        { name: 'validate(result)', type: 'codeblock' },
      ]),
    );
  });

  it('extracts refs from <a> link text', () => {
    const p = new HtmlParser();
    const content = [
      '<h2>See Also</h2>',
      '<p>Check <a href="../src/auth.ts">login()</a> for details.</p>',
    ].join('\n');

    const sections = p.parse('docs/links.html', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'link');
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'login()', type: 'link' },
      ]),
    );
  });

  it('strips HTML tags from heading text', () => {
    const p = new HtmlParser();
    const content = [
      '<h2>The <code>authenticate()</code> Function</h2>',
      '<p>Content.</p>',
    ].join('\n');

    const sections = p.parse('docs/tagged.html', content);
    expect(sections).toHaveLength(1);
    expect(sections[0].anchor).toBe('The authenticate() Function');
  });
});

// ── getParser (factory) ────────────────────────────────────────────────────

describe('getParser', () => {
  it('returns MarkdownParser for .md', () => {
    const p = getParser('.md');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('markdown');
  });

  it('returns MarkdownParser for .mdx', () => {
    const p = getParser('.mdx');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('markdown');
  });

  it('returns RstParser for .rst', () => {
    const p = getParser('.rst');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('rst');
  });

  it('returns AsciidocParser for .adoc and .asciidoc', () => {
    expect(getParser('.adoc')!.name).toBe('asciidoc');
    expect(getParser('.asciidoc')!.name).toBe('asciidoc');
  });

  it('returns HtmlParser for .html and .htm', () => {
    expect(getParser('.html')!.name).toBe('html');
    expect(getParser('.htm')!.name).toBe('html');
  });

  it('returns null for unsupported extensions', () => {
    expect(getParser('.txt')).toBeNull();
    expect(getParser('.pdf')).toBeNull();
    expect(getParser('.docx')).toBeNull();
    expect(getParser('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(getParser('.MD')!.name).toBe('markdown');
    expect(getParser('.RST')!.name).toBe('rst');
    expect(getParser('.HTML')!.name).toBe('html');
  });
});

// ── getAllParsers ──────────────────────────────────────────────────────────

describe('getAllParsers', () => {
  it('returns all 4 parsers', () => {
    const parsers = getAllParsers();
    expect(parsers).toHaveLength(4);
    const names = parsers.map((p) => p.name).sort();
    expect(names).toEqual(['asciidoc', 'html', 'markdown', 'rst']);
  });
});

// ── DocParser interface compliance ─────────────────────────────────────────

describe('DocParser interface compliance', () => {
  const parsers: DocParser[] = [new MarkdownParser(), new RstParser(), new AsciidocParser(), new HtmlParser()];

  for (const parser of parsers) {
    it(`${parser.name} parser has required properties`, () => {
      expect(typeof parser.name).toBe('string');
      expect(parser.name.length).toBeGreaterThan(0);
      expect(Array.isArray(parser.extensions)).toBe(true);
      expect(parser.extensions.length).toBeGreaterThan(0);
      expect(typeof parser.parse).toBe('function');
    });

    it(`${parser.name} parse returns array of ParsedDocSection`, () => {
      const sections = parser.parse('test', '');
      expect(Array.isArray(sections)).toBe(true);
    });

    it(`${parser.name} ParsedDocSection has required fields`, () => {
      const content = '# Section\nContent with `func()`.\n';
      const sections = parser.parse('test.md', content);
      if (sections.length > 0) {
        for (const s of sections) {
          expect(typeof s.file).toBe('string');
          expect(typeof s.anchor).toBe('string');
          expect(typeof s.content).toBe('string');
          expect(Array.isArray(s.codeRefs)).toBe(true);
          for (const ref of s.codeRefs) {
            expect(typeof ref.symbolName).toBe('string');
            expect(['backtick', 'codeblock', 'link', 'heading', 'bodytext']).toContain(ref.refType);
            expect(typeof ref.confidence).toBe('number');
            expect(ref.confidence).toBeGreaterThanOrEqual(0);
            expect(ref.confidence).toBeLessThanOrEqual(1);
            expect(typeof ref.lineInDoc).toBe('number');
            expect(ref.lineInDoc).toBeGreaterThanOrEqual(1);
          }
        }
      }
    });
  }
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('handles markdown with only code blocks (no headings)', () => {
    const p = new MarkdownParser();
    const content = [
      '```python',
      'def hello():',
      '    print("world")',
      '```',
    ].join('\n');

    const sections = p.parse('code-only.md', content);
    expect(sections).toHaveLength(1);
    const refs = sections[0].codeRefs.filter((r) => r.refType === 'codeblock');
    expect(refs).toEqual(
      expect.arrayContaining([
        { symbolName: 'hello()', refType: 'codeblock', confidence: 0.9, lineInDoc: 2 },
      ]),
    );
  });

  it('handles RST with no headings', () => {
    const p = new RstParser();
    const content = 'Plain text without any heading markup.\n:func:`doWork` is useful.';

    const sections = p.parse('plain.rst', content);
    expect(sections).toHaveLength(1);
    expect(sections[0].anchor).toBe('');
  });

  it('does not extract refs from plain text function calls (not in backticks/code)', () => {
    const p = new MarkdownParser();
    const content = '## Section\nJust writing about login() in plain text without backticks.';

    const sections = p.parse('plain.md', content);
    // Plain function calls are only detected inside code blocks, not in body text
    // (to avoid false positives on natural language)
    const backtickRefs = sections.flatMap((s) => s.codeRefs).filter((r) => r.refType === 'backtick');
    // No backtick-wrapped symbols in the content, so no refs
    expect(backtickRefs).toHaveLength(0);
  });

  it('extracts a weak bodytext ref for a bare lowercase identifier in prose (test ③)', () => {
    const p = new MarkdownParser();
    const content = '## Login\nThe login routine is used at startup.';

    const sections = p.parse('prose.md', content);
    const bodytextRefs = sections.flatMap((s) => s.codeRefs).filter((r) => r.refType === 'bodytext');
    // 'login' and 'startup' are non-stopword identifiers; 'The'/'routine'/'used'*
    // are stopwords and must not appear. 'login' is the case under test.
    const names = bodytextRefs.map((r) => r.symbolName);
    expect(names).toContain('login');
    expect(bodytextRefs[names.indexOf('login')].confidence).toBeLessThan(0.5);
  });

  it('does not create bodytext refs for common English stopwords', () => {
    const p = new MarkdownParser();
    const content = '## Section\nThe function returns this result from the method call.';

    const sections = p.parse('prose.md', content);
    const names = sections.flatMap((s) => s.codeRefs).filter((r) => r.refType === 'bodytext').map((r) => r.symbolName.toLowerCase());
    // 'the', 'function', 'returns', 'this', 'result', 'method', 'call' are all
    // stopwords — none should be emitted as weak refs.
    for (const stop of ['the', 'function', 'returns', 'this', 'result', 'method', 'call']) {
      expect(names).not.toContain(stop);
    }
  });

  it('does not create a bodytext ref for an identifier already captured as a backtick ref', () => {
    const p = new MarkdownParser();
    const content = '## Section\nUse `login` in the app.';

    const sections = p.parse('prose.md', content);
    const bodytextRefs = sections.flatMap((s) => s.codeRefs).filter((r) => r.refType === 'bodytext');
    const backtickRefs = sections.flatMap((s) => s.codeRefs).filter((r) => r.refType === 'backtick');
    // 'login' is already captured as a backtick ref — it must not be duplicated
    // as a weak bodytext ref (this avoids downgrading a strong match).
    expect(backtickRefs.map((r) => r.symbolName)).toContain('login');
    expect(bodytextRefs.map((r) => r.symbolName)).not.toContain('login');
  });

  it('handles deeply nested headings', () => {
    const p = new MarkdownParser();
    const content = [
      '## Top',
      'Content.',
      '#### Level 4',
      'Deep content.',
    ].join('\n');

    const sections = p.parse('nested.md', content);
    expect(sections).toHaveLength(2);
    expect(sections[0].anchor).toBe('Top');
    expect(sections[1].anchor).toBe('Level 4');
  });

  it('handles multiple code refs in the same line', () => {
    const p = new MarkdownParser();
    const content = [
      '## Multi',
      'Use `foo()` and `bar()` together.',
    ].join('\n');

    const sections = p.parse('multi.md', content);
    const refs = collectCodeRefs(sections).filter((r) => r.type === 'backtick');
    expect(refs).toHaveLength(2);
    expect(refs).toEqual(
      expect.arrayContaining([
        { name: 'foo()', type: 'backtick' },
        { name: 'bar()', type: 'backtick' },
      ]),
    );
  });
});

// ── Branch coverage: resource guards, preambles, bracket-counting paths ────

describe('parser resource guards and preamble capture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('markdown: skips files exceeding MAX_DOC_LINES', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new MarkdownParser();
    const sections = p.parse('big.md', 'x\n'.repeat(100_001));
    expect(sections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MarkdownParser'));
  });

  it('markdown: captures preamble before the first heading as a top section', () => {
    const p = new MarkdownParser();
    const sections = p.parse('guide.md', 'preamble intro\n\n## First\nbody text');
    expect(sections).toHaveLength(2);
    expect(sections[0].anchor).toBe('');
    expect(sections[0].content).toContain('preamble intro');
    expect(sections[1].anchor).toBe('First');
  });

  it('rst: skips files exceeding MAX_DOC_LINES', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new RstParser();
    const sections = p.parse('big.rst', 'x\n'.repeat(100_001));
    expect(sections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RstParser'));
  });

  it('rst: captures preamble before the first heading as a top section', () => {
    const p = new RstParser();
    const content = ['preamble text', '', 'First', '=====', 'body text'].join('\n');
    const sections = p.parse('guide.rst', content);
    expect(sections).toHaveLength(2);
    expect(sections[0].anchor).toBe('');
    expect(sections[0].content).toContain('preamble text');
    expect(sections[1].anchor).toBe('First');
  });

  it('asciidoc: skips files exceeding MAX_DOC_LINES', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new AsciidocParser();
    const sections = p.parse('big.adoc', 'x\n'.repeat(100_001));
    expect(sections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AsciidocParser'));
  });

  it('asciidoc: captures preamble before the first heading as a top section', () => {
    const p = new AsciidocParser();
    const sections = p.parse('guide.adoc', 'preamble text\n\n== First\nbody text');
    expect(sections).toHaveLength(2);
    expect(sections[0].anchor).toBe('');
    expect(sections[0].content).toContain('preamble text');
    expect(sections[1].anchor).toBe('First');
  });

  it('html: skips content exceeding the 10MB size limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new HtmlParser();
    const sections = p.parse('big.html', 'a'.repeat(10 * 1024 * 1024 + 1));
    expect(sections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds 10485760 bytes'));
  });

  it('html: caps heading matches at MAX_HEADINGS', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new HtmlParser();
    const sections = p.parse('many.html', '<h1>x</h1>'.repeat(50_001));
    expect(sections).toHaveLength(50_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('50000 headings'));
  });

  it('html: captures preamble before the first heading tag as a top section', () => {
    const p = new HtmlParser();
    const sections = p.parse('guide.html', '<p>intro para</p>\n<h1>Title</h1>\n<p>body text</p>');
    expect(sections).toHaveLength(2);
    expect(sections[0].anchor).toBe('');
    expect(sections[0].content).toContain('intro para');
    expect(sections[1].anchor).toBe('Title');
  });

  it('html: skips content exceeding MAX_HTML_LINES', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new HtmlParser();
    const content = '<h1>T</h1>\n' + 'x\n'.repeat(100_001);
    const sections = p.parse('long.html', content);
    expect(sections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeding 100000'));
  });

  it('html: caps extracted code refs at MAX_CODE_REFS_PER_FILE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new HtmlParser();
    const lines = Array.from({ length: 6000 }, (_, i) => `<code>fn${i}()</code>`);
    const sections = p.parse('refs.html', '<h1>T</h1>\n' + lines.join('\n'));
    expect(sections).toHaveLength(1);
    expect(sections[0].codeRefs).toHaveLength(10_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reached limit of 10000 refs'));
  });

  it('html: warns when a pre block exceeds MAX_PRE_LINES', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new HtmlParser();
    const preLines = Array.from({ length: 5001 }, (_, i) => `code_line_${i}`);
    const content = '<h1>T</h1>\n<pre>\n' + preLines.join('\n') + '\n</pre>';
    const sections = p.parse('pre.html', content);
    expect(sections).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('extractPreContent'));
  });
});

// ── Branch coverage: bracket-counting and heading extraction paths ─────────

describe('backtick call bracket counting', () => {
  it('extracts backtick calls with nested backticks inside arguments', () => {
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## API\nUse `foo(`inner`)` here.');
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([{ name: 'foo(`inner`)', type: 'backtick' }]),
    );
  });

  it('skips escaped backticks inside nested backtick arguments', () => {
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## API\nUse `foo(`a\\`b`)` here.');
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([{ name: 'foo(`a\\`b`)', type: 'backtick' }]),
    );
  });

  it('scan-ahead adjusts paren depth between the call and its closing backtick', () => {
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## API\nUse `foo(a) extra (b)` here.');
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([{ name: 'foo(a) extra (b)', type: 'backtick' }]),
    );
  });

  it('ignores unterminated backtick calls', () => {
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## API\nUse `foo(bar here.');
    const refs = collectCodeRefs(sections);
    expect(refs.find((r) => r.name.startsWith('foo('))).toBeUndefined();
  });

  it('accepts a depth-zero closing backtick after a failed scan-ahead', () => {
    // Pathological input: the first `) brings depth to 0 but the scan-ahead
    // finds a backtick while depth is negative (extra `)`), so extraction
    // continues; the nested `` pair opens/closes, two `(` bring depth back
    // to exactly 0, and the next backtick terminates the expression.
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## API\nUse `foo(a))``((` here.');
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([{ name: 'foo(a))``((', type: 'backtick' }]),
    );
  });
});

describe('heading and body-text identifier extraction', () => {
  it('treats snake_case words as code-like bodytext refs', () => {
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## Config\nSet your_api_key first.');
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([{ name: 'your_api_key', type: 'bodytext' }]),
    );
  });

  it('extracts backtick symbol refs from headings', () => {
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## `login` Flow\nbody text');
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([{ name: 'login', type: 'heading' }]),
    );
  });

  it('skips heading function-call extraction when parens are unbalanced', () => {
    const p = new MarkdownParser();
    const sections = p.parse('t.md', '## foo(bar\nbody text');
    const refs = collectCodeRefs(sections);
    expect(refs.find((r) => r.type === 'heading')).toBeUndefined();
    expect(refs.find((r) => r.name.startsWith('foo('))).toBeUndefined();
  });
});

describe('rst code block termination', () => {
  it('ends a code block at a blank line followed by unindented text', () => {
    const p = new RstParser();
    const content = [
      'Title',
      '=====',
      '',
      '.. code::',
      '',
      '    some_call()',
      '',
      'After other_func() text.',
    ].join('\n');
    const sections = p.parse('t.rst', content);
    const refs = collectCodeRefs(sections);
    expect(refs).toEqual(
      expect.arrayContaining([{ name: 'some_call()', type: 'codeblock' }]),
    );
    // The unindented line after the blank line is outside the code block, so
    // other_func() must not be captured as a codeblock ref.
    expect(refs.filter((r) => r.type === 'codeblock')).toHaveLength(1);
  });
});
