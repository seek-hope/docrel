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
