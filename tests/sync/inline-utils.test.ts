import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  stripAllBlockComments,
  stripCommentsAndStrings,
  generateUpdatedDocstring,
} from '../../src/sync/inline.js';

afterEach(() => vi.restoreAllMocks());

describe('stripAllBlockComments', () => {
  it('strips both plain and JSDoc block comments', () => {
    const src = 'const a = 1; /* note */ const b = 2;\n/** jsdoc */\nconst c = 3;';
    const out = stripAllBlockComments(src);
    expect(out).toBe('const a = 1;  const b = 2;\n\nconst c = 3;');
  });

  it('keeps comment markers inside string literals', () => {
    const src = 'const s = "/* not a comment */";\nconst t = \'/* also not */\';\nconst u = `/* template */`;';
    expect(stripAllBlockComments(src)).toBe(src);
  });

  it('keeps markers inside nested template-literal interpolations', () => {
    const src = 'const u = `outer ${fn(`inner /* x */`)} end`;';
    expect(stripAllBlockComments(src)).toBe(src);
  });

  it('handles escaped quotes inside strings', () => {
    // The whole "escaped \" /* real */ end" is one string — nothing to strip.
    const whole = 'const s = "escaped \\" /* real */ end";';
    expect(stripAllBlockComments(whole)).toBe(whole);
    // Comment AFTER a properly closed string is stripped.
    const after = 'const s = "a\\"b"; /* real */';
    expect(stripAllBlockComments(after)).toBe('const s = "a\\"b"; ');
  });
});

describe('stripCommentsAndStrings', () => {
  it('strips line comments at safe positions', () => {
    expect(stripCommentsAndStrings('// whole line')).toBe('');
    expect(stripCommentsAndStrings('const a = 1; // trailing')).toBe('const a = 1; ');
    expect(stripCommentsAndStrings('{ // after brace')).toBe('{ ');
  });

  it('keeps // inside regex literals', () => {
    const src = 'const ok = /https:\\/\\//.test(url);';
    expect(stripCommentsAndStrings(src)).toBe(src);
  });

  it('strips string contents but keeps code around them', () => {
    expect(stripCommentsAndStrings('call("arg", \'other\')')).toBe('call(, )');
  });

  it('strips block comments within a line', () => {
    expect(stripCommentsAndStrings('code /* note */ more')).toBe('code  more');
  });

  it('tracks nested template literals', () => {
    // the template TAG (css) is code and stays
    expect(stripCommentsAndStrings('css`a ${fn(`b`)} c` + 1')).toBe('css + 1');
  });
});

describe('generateUpdatedDocstring', () => {
  it('generates a placeholder docstring from the signature when there is no old doc', () => {
    const out = generateUpdatedDocstring('login', 'function', '', 'export function login(user: string, pass: string): boolean {');
    expect(out).toContain('/**');
    expect(out).toContain(' * login — [auto-updated by DocRelay]');
    expect(out).toContain(' * @param user — string');
    expect(out).toContain(' * @param pass — string');
    expect(out).toContain(' * @returns {boolean}');
    expect(out).toContain(' */');
  });

  it('preserves narrative lines and re-attaches hand-written param descriptions', () => {
    const old = [
      '/**',
      ' * Authenticates a user against the directory.',
      ' *',
      ' * Example: login("root", "hunter2")',
      ' * @param user — the login name',
      ' * @param pass — the password',
      ' * @returns true when credentials are valid',
      ' */',
    ].join('\n');
    const out = generateUpdatedDocstring('login', 'function', old, 'export function login(user: string, pass: string, mfa: boolean): Promise<boolean> {');

    // Narrative survives
    expect(out).toContain('Authenticates a user against the directory.');
    expect(out).toContain('Example: login("root", "hunter2")');
    // Hand-written descriptions reused for existing params
    expect(out).toContain(' * @param user — the login name');
    expect(out).toContain(' * @param pass — the password');
    // New param gets its type as description
    expect(out).toContain(' * @param mfa — boolean');
    // Return description preserved with fresh type
    expect(out).toContain(' * @returns {Promise<boolean>} true when credentials are valid');
  });

  it('replaces bare-type auto-generated descriptions with fresh types', () => {
    const old = '/**\n * @param count — number\n */';
    const out = generateUpdatedDocstring('f', 'function', old, 'function f(count: bigint): void {');
    expect(out).toContain(' * @param count — bigint');
  });

  it('handles generic signatures with function-typed constraints', () => {
    const out = generateUpdatedDocstring('apply', 'function', '', 'function apply<T extends (x: number) => boolean>(fn: T, value: number): boolean {');
    expect(out).toContain(' * @param fn — T');
    expect(out).toContain(' * @param value — number');
    expect(out).toContain(' * @returns {boolean}');
  });

  it('keeps default values containing commas inside strings as one param', () => {
    const out = generateUpdatedDocstring('greet', 'function', '', 'function greet(name: string = "hello, world"): string {');
    expect(out).toContain(' * @param name — string');
    expect(out.match(/@param/g)).toHaveLength(1);
  });

  it('warns and truncates pathologically long signatures', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longSig = `function f(a${'1'.repeat(3000)}: string): void {`;
    const out = generateUpdatedDocstring('f', 'function', '', longSig);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds 2000 chars'));
    expect(out).toContain('/**');
  });

  it('omits @returns for untyped signatures', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f(a, b) {');
    expect(out).not.toContain('@returns');
  });
});

describe('stripAllBlockComments regex literals', () => {
  it('keeps regex literals containing comment markers', () => {
    const src = 'const r = /\\/\\*not-a-comment\\*\\//g; /* real */';
    expect(stripAllBlockComments(src)).toBe('const r = /\\/\\*not-a-comment\\*\\//g; ');
  });

  it('keeps character classes inside regex literals', () => {
    const src = 'const r = /[/]+/; /* c */';
    expect(stripAllBlockComments(src)).toBe('const r = /[/]+/; ');
  });

  it('treats slash after keywords as a regex delimiter', () => {
    const src = 'return /re/; /* c */';
    expect(stripAllBlockComments(src)).toBe('return /re/; ');
  });

  it('treats slash at content start as a regex delimiter', () => {
    expect(stripAllBlockComments('/re/; /* c */')).toBe('/re/; ');
  });

  it('treats slash after identifiers as division', () => {
    expect(stripAllBlockComments('const q = a / b; /* c */')).toBe('const q = a / b; ');
  });

  it('treats slash after a closing paren as division', () => {
    expect(stripAllBlockComments('const q = (a) / b; /* c */')).toBe('const q = (a) / b; ');
  });

  it('keeps strings ending in a backslash', () => {
    expect(stripAllBlockComments('const s = "ab\\')).toBe('const s = "ab\\');
    expect(stripAllBlockComments("const s = 'ab\\'")).toBe("const s = 'ab\\'");
    expect(stripAllBlockComments('const t = `ab\\')).toBe('const t = `ab\\');
  });

  it('keeps escaped quotes in single-quoted and template strings', () => {
    expect(stripAllBlockComments("const s = 'a\\'b'; /* c */")).toBe("const s = 'a\\'b'; ");
    expect(stripAllBlockComments('const t = `a\\`b`; /* c */')).toBe('const t = `a\\`b`; ');
  });
});

describe('stripCommentsAndStrings escapes', () => {
  it('handles escaped quotes inside strings', () => {
    expect(stripCommentsAndStrings('call("a\\"b")')).toBe('call()');
    expect(stripCommentsAndStrings("call('a\\'b')")).toBe('call()');
    expect(stripCommentsAndStrings('call(`a\\`b`)')).toBe('call()');
  });

  it('handles strings ending in a backslash', () => {
    expect(stripCommentsAndStrings('call("ab\\')).toBe('call(');
    expect(stripCommentsAndStrings("call('ab\\")).toBe('call(');
    expect(stripCommentsAndStrings('call(`ab\\')).toBe('call(');
  });
});

describe('generateUpdatedDocstring resource guards', () => {
  it('falls back to a signature-derived docstring when the old doc exceeds 100k lines', () => {
    const old = '/**\n' + ' * narrative\n'.repeat(100_001) + ' */';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = generateUpdatedDocstring('f', 'function', old, 'function f(a: string): void {');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds 100000'));
    expect(out).toContain('f — [auto-updated by DocRelay]');
    expect(out).toContain('@param a — string');
  });

  it('caps preserved narrative lines at 2000', () => {
    const old = ['/**', ...Array.from({ length: 2001 }, (_, i) => ` * narrative-${i}`), ' */'].join('\n');
    const out = generateUpdatedDocstring('f', 'function', old, 'function f(a: string): void {');
    expect(out).toContain('narrative-1999');
    expect(out).not.toContain('narrative-2000');
  });

  it('resets tag blocks at other tags and skips their continuation lines', () => {
    const old = [
      '/**',
      ' * Does things.',
      ' * @param a — first param',
      ' *   continuation of a',
      ' * @deprecated use g instead',
      ' * trailing narrative',
      ' */',
    ].join('\n');
    const out = generateUpdatedDocstring('f', 'function', old, 'function f(a: string, b: number): void {');
    expect(out).toContain('Does things.');
    expect(out).toContain('@param a — first param');
    expect(out).not.toContain('continuation of a');
    expect(out).toContain('trailing narrative');
  });
});

describe('generateUpdatedDocstring signature parsing', () => {
  it('handles signatures without a parameter list', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f');
    expect(out).toContain('f — [auto-updated by DocRelay]');
    expect(out).not.toContain('@param');
    expect(out).not.toContain('@returns');
  });

  it('omits @returns when the signature ends right after the colon', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f():');
    expect(out).not.toContain('@returns');
  });

  it('stops return-type collection at unmatched closing brackets', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f(): void);');
    expect(out).toContain('@returns {void}');
  });

  it('refreshes PascalCase bare-type param descriptions', () => {
    const old = '/**\n * @param x — User\n */';
    const out = generateUpdatedDocstring('f', 'function', old, 'function f(x: Admin): void {');
    expect(out).toContain('@param x — Admin');
  });

  it('refreshes primitive-array bare-type param descriptions', () => {
    const old = '/**\n * @param x — string[]\n */';
    const out = generateUpdatedDocstring('f', 'function', old, 'function f(x: number[]): void {');
    expect(out).toContain('@param x — number[]');
  });

  it('preserves single-token prose param descriptions', () => {
    const old = '/**\n * @param x — hunter2\n */';
    const out = generateUpdatedDocstring('f', 'function', old, 'function f(x: string): void {');
    expect(out).toContain('@param x — hunter2');
  });

  it('splits destructured params at the outer colon', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f({a}: Options, b: string): void {');
    expect(out).toContain('@param {a} — Options');
    expect(out).toContain('@param b — string');
  });

  it('handles string literals before the type colon', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f("a\\"b": string): void {');
    expect(out).toContain('@param "a\\"b" — string');
  });

  it('handles template placeholders before the type colon', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f(`a${b}c`: string): void {');
    expect(out).toContain('@param `a${b}c` — string');
  });

  it('keeps escaped commas inside string defaults as one param', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f(a: string = "x\\",y", b: number): void {');
    expect(out).toContain('@param a — string');
    expect(out).toContain('@param b — number');
    expect(out.match(/@param/g)).toHaveLength(2);
  });

  it('keeps template interpolations as one param', () => {
    const out = generateUpdatedDocstring('f', 'function', '', 'function f(a: string = `x${y}z`, b: number): void {');
    expect(out).toContain('@param a — string');
    expect(out).toContain('@param b — number');
    expect(out.match(/@param/g)).toHaveLength(2);
  });
});
