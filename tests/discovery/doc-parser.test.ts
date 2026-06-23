import { describe, it, expect } from 'vitest';
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
            expect(['backtick', 'codeblock', 'link', 'heading']).toContain(ref.refType);
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
