import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  updateStandaloneDoc,
  findSectionContent,
  findSectionContentFromString,
  replaceSectionSignature,
} from '../../src/sync/standalone.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DOC = [
  '# Title',
  '',
  'preamble text',
  '',
  '## install',
  '',
  'Run `npm install`.',
  '',
  '## usage',
  '',
  'Call `login(user, pass)` to authenticate.',
  '',
].join('\n');

describe('updateStandaloneDoc', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-standalone-'));
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), DOC, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function update(overrides: Partial<{ file: string; anchor: string; oldContent: string; newContent: string }> = {}) {
    return updateStandaloneDoc({
      file: overrides.file ?? 'docs/api.md',
      anchor: overrides.anchor ?? 'usage',
      oldContent: overrides.oldContent ?? 'login(user, pass)',
      newContent: overrides.newContent ?? 'login(user, password, mfa)',
    }, tmpDir);
  }

  it('rejects path traversal', () => {
    const r = update({ file: '../../etc/passwd' });
    expect(r).toEqual({ success: false, reason: 'invalid file path or path traversal detected' });
  });

  it('rejects a missing file (validatePath nulls non-existent paths)', () => {
    const r = update({ file: 'docs/gone.md' });
    expect(r.success).toBe(false);
    expect(r.reason).toContain('invalid file path');
  });

  it('rejects a path that exists but is not a regular file', () => {
    const r = update({ file: 'docs' }); // a directory passes validatePath, fails fd validation
    expect(r.success).toBe(false);
    expect(r.reason).toContain('could not read or validate file');
  });

  it('rejects empty old or new content', () => {
    expect(update({ oldContent: '   ' }).reason).toContain('empty oldContent');
    expect(update({ newContent: '' }).reason).toContain('empty oldContent');
  });

  it('rejects an unknown section anchor', () => {
    expect(update({ anchor: 'nonexistent' }).reason).toContain("section 'nonexistent' not found");
  });

  it('rejects oldContent absent from the section', () => {
    expect(update({ oldContent: 'not in the doc' }).reason).toBe('oldContent not found in section');
  });

  it('rejects ambiguous oldContent occurring more than once', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'api.md'),
      '## usage\n\nlogin and login again\n',
      'utf-8',
    );
    const r = update({ oldContent: 'login' });
    expect(r.reason).toBe('oldContent appears 2 times in section (expected 1)');
  });

  it('replaces exactly one occurrence and preserves file mode', () => {
    fs.chmodSync(path.join(tmpDir, 'docs', 'api.md'), 0o640);
    const r = update();
    expect(r).toEqual({ success: true });

    const after = fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8');
    expect(after).toContain('login(user, password, mfa)');
    expect(after).not.toContain('login(user, pass)');
    // Other sections untouched
    expect(after).toContain('Run `npm install`.');
    expect(fs.statSync(path.join(tmpDir, 'docs', 'api.md')).mode & 0o777).toBe(0o640);
  });

  it('treats $-patterns in newContent literally (no regex substitution)', () => {
    const r = update({ newContent: 'cost is $& and $1' });
    expect(r.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8')).toContain('cost is $& and $1');
  });

  it('aligns LF oldContent to a CRLF file and keeps CRLF endings', () => {
    const crlf = DOC.replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), crlf, 'utf-8');

    const r = update({ oldContent: 'Call `login(user, pass)` to authenticate.', newContent: 'Call `login(u, p, mfa)`.' });
    expect(r.success).toBe(true);

    const raw = fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8');
    expect(raw).toContain('Call `login(u, p, mfa)`.');
    expect(raw).toContain('\r\n');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('fails post-validation when old and new content are identical', () => {
    const r = update({ oldContent: 'login(user, pass)', newContent: 'login(user, pass)' });
    expect(r.success).toBe(false);
    expect(r.reason).toContain('oldContent still present');
  });
});

describe('findSectionContent / findSectionContentFromString', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-findsec-'));
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), DOC, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('locates a section bounded by the next heading', () => {
    const s = findSectionContent('docs/api.md', 'install', tmpDir);
    expect(s).toContain('## install');
    expect(s).toContain('Run `npm install`.');
    expect(s).not.toContain('## usage');
  });

  it('returns the preamble for an empty anchor', () => {
    const s = findSectionContentFromString('intro line\n\nmore intro\n\n## first\n\nbody\n', '');
    expect(s).toBe('intro line\n\nmore intro\n');
    // A document starting with a heading has an empty preamble.
    expect(findSectionContentFromString(DOC, '')).toBe('');
  });

  it('returns the whole document when there is no heading and anchor is empty', () => {
    expect(findSectionContentFromString('just text\nmore text', '')).toBe('just text\nmore text');
  });

  it('ignores headings inside fenced code blocks', () => {
    const doc = '## real\n\n```md\n## fake\n```\n\nbody\n';
    expect(findSectionContentFromString(doc, 'fake')).toBeNull();
    const s = findSectionContentFromString(doc, 'real');
    expect(s).toContain('## fake'); // inside the code block, part of real's section
    expect(s).toContain('body');
  });

  it('returns null for a missing anchor, a missing file, or traversal', () => {
    expect(findSectionContentFromString(DOC, 'nope')).toBeNull();
    expect(findSectionContent('docs/gone.md', 'install', tmpDir)).toBeNull();
    expect(findSectionContent('../../etc/passwd', 'install', tmpDir)).toBeNull();
    expect(findSectionContent('docs/api.md', 'install', '')).toBeNull();
  });

  it('rejects over-long anchors', () => {
    expect(findSectionContentFromString(DOC, 'x'.repeat(1000))).toBeNull();
  });
});

describe('replaceSectionSignature', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-sig-'));
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'api.md'),
      '## auth\n\n`login(user, pass)` — logs in.\n\nExample: login(user, pass) again.\n',
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces ALL occurrences within the section only', () => {
    const r = replaceSectionSignature({
      file: 'docs/api.md', anchor: 'auth',
      oldText: 'login(user, pass)', newText: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(true);
    expect(r.newSection).toBeTruthy();

    const after = fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8');
    expect(after.match(/login\(user, password, mfa\)/g)).toHaveLength(2);
    expect(after).not.toContain('login(user, pass)');
  });

  it('rejects empty texts, unknown sections, missing old text, and traversal', () => {
    expect(replaceSectionSignature({ file: 'docs/api.md', anchor: 'auth', oldText: ' ', newText: 'x' }, tmpDir).reason)
      .toBe('empty old signature text');
    expect(replaceSectionSignature({ file: 'docs/api.md', anchor: 'auth', oldText: 'x', newText: '' }, tmpDir).reason)
      .toBe('empty new signature text');
    expect(replaceSectionSignature({ file: 'docs/api.md', anchor: 'nope', oldText: 'x', newText: 'y' }, tmpDir).reason)
      .toContain("section 'nope' not found");
    expect(replaceSectionSignature({ file: 'docs/api.md', anchor: 'auth', oldText: 'absent', newText: 'y' }, tmpDir).reason)
      .toBe('old signature text not found in section');
    expect(replaceSectionSignature({ file: '../outside.md', anchor: 'auth', oldText: 'x', newText: 'y' }, tmpDir).reason)
      .toContain('traversal');
  });
});

describe('standalone.ts guard and fault-injection paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-stguard-'));
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), DOC, 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- findSectionContentFromString guards ---

  it('rejects an anchor longer than 1000 chars with a warning', () => {
    expect(findSectionContentFromString(DOC, 'x'.repeat(1001))).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('anchor rejected'));
  });

  it('rejects content over 100k lines with a warning', () => {
    expect(findSectionContentFromString('x\n'.repeat(100_001), '')).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds limit'));
  });

  it('does not close a fence on a shorter token (preamble path)', () => {
    // The ```` fence opens with 4 backticks; the ``` line is shorter, so the
    // fence stays open and no ATX heading is ever seen — the whole document
    // becomes the preamble (engine.ts:297 false branch).
    const doc = '````\n## hidden\n```\ntext\n';
    expect(findSectionContentFromString(doc, '')).toBe(doc);
  });

  it('does not close a fence on a shorter token (heading-locate path)', () => {
    // The anchor heading sits inside a fence that never closes, so the
    // heading search never matches it (engine.ts:340 false branch).
    const doc = '````\n```\n## real\n';
    expect(findSectionContentFromString(doc, 'real')).toBeNull();
  });

  it('does not close a fence on a shorter token (section-end path)', () => {
    // A would-be section boundary inside an unclosed fence is ignored, so the
    // section extends past it (engine.ts:377 false branch).
    const doc = '## real\n\n````\n```\n## other\n';
    const s = findSectionContentFromString(doc, 'real');
    expect(s).toContain('## other');
  });

  // --- updateStandaloneDoc guards ---

  it('rejects an oldContent over the occurrence-counting limit', () => {
    // escapeRegexGlobal's default cap is 200 chars; the oversized oldContent
    // must still be present in the section to reach the regex build.
    const giant = 'x'.repeat(201);
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'), `## auth\n\n${giant}\n`, 'utf-8');
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'auth',
      oldContent: giant, newContent: 'y',
    }, tmpDir);
    expect(r.reason).toBe('oldContent too long for occurrence counting');
  });

  it('fails post-validation when newContent already appears in the section', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'api.md'),
      '## auth\n\nfoo NEW\n\nOLD\n',
      'utf-8',
    );
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'auth', oldContent: 'OLD', newContent: 'NEW',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('post-validation failed — newContent appears 2 times (expected 1)');
  });

  it('reports when the temp directory cannot be created', () => {
    fs.writeFileSync(path.join(tmpDir, '.docrelay'), 'not a directory', 'utf-8');
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toContain('could not create temp directory');
  });

  it('reports when the atomic write fails', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('atomic write failed');
  });

  it('reports when the fd realpath escapes the project root', () => {
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p).startsWith('/proc/self/fd/')) return '/etc/passwd';
      return real(p);
    });
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('could not read or validate file');
  });

  it('warns and reports when open fails with a non-ENOENT error', () => {
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('could not read or validate file');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('openAndValidate failed'), expect.anything());
  });

  it('validates via the non-Linux fallback in openAndValidate', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const r = updateStandaloneDoc({
        file: 'docs/api.md', anchor: 'usage',
        oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
      }, tmpDir);
      expect(r.success).toBe(true);
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig);
    }
  });

  it('returns null silently when open fails without an error code', () => {
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('plain failure, no code');
    });
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('openAndValidate failed'), expect.anything());
  });

  it('skips the new-content recount when newContent exceeds the regex cap', () => {
    const giantNew = 'y'.repeat(201);
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: giantNew,
    }, tmpDir);
    expect(r.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8')).toContain(giantNew);
  });

  it('reports an unknown temp-directory failure code', () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('plain failure, no code');
    });
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('could not create temp directory: unknown');
  });

  it('formats non-Error throws in the openAndValidate warning', () => {
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: 'EIO' }; // non-Error throw exercises the `instanceof Error` warn ternary
    });
    const r = updateStandaloneDoc({
      file: 'docs/api.md', anchor: 'usage',
      oldContent: 'login(user, pass)', newContent: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('openAndValidate failed'), { code: 'EIO' });
  });

  // --- findSectionContent filesystem guards ---

  it('returns null when the doc is a symlink escaping the project root', () => {
    const outside = path.join(tmpDir, '..', `outside-${Date.now()}.md`);
    fs.writeFileSync(outside, '## secret\n', 'utf-8');
    try {
      fs.symlinkSync(outside, path.join(tmpDir, 'docs', 'link.md'));
      expect(findSectionContent('docs/link.md', 'secret', tmpDir)).toBeNull();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('warns and returns null when realpath resolution fails with ELOOP', () => {
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p).endsWith('api.md')) {
        throw Object.assign(new Error('ELOOP: too many levels of symbolic links'), { code: 'ELOOP' });
      }
      return real(p);
    });
    expect(findSectionContent('docs/api.md', 'usage', tmpDir)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cannot resolve real path'));
  });

  it('returns null when the doc path is a directory', () => {
    expect(findSectionContent('docs', 'usage', tmpDir)).toBeNull();
  });

  it('returns null when the fd realpath escapes the project root', () => {
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
      if (String(p).startsWith('/proc/self/fd/')) return '/etc/passwd';
      return real(p);
    });
    expect(findSectionContent('docs/api.md', 'usage', tmpDir)).toBeNull();
  });

  it('falls back to path-based fd validation on non-Linux platforms', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      // Happy path still reads the section via the realpathSync(real) fallback.
      expect(findSectionContent('docs/api.md', 'usage', tmpDir)).toContain('login(user, pass)');
      // And an escaping realpath is still rejected.
      const real = fs.realpathSync;
      vi.spyOn(fs, 'realpathSync').mockImplementation((p: any) => {
        if (String(p).endsWith('api.md') && !String(p).includes('.git')) {
          // First call (lexical resolution) must succeed; the fd fallback call
          // happens on the same path — distinguish by call count.
          if (vi.mocked(fs.realpathSync).mock.calls.length > 1) return '/etc/passwd';
        }
        return real(p);
      });
      expect(findSectionContent('docs/api.md', 'usage', tmpDir)).toBeNull();
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig);
    }
  });

  it('returns null silently when open fails with ENOENT', () => {
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    expect(findSectionContent('docs/api.md', 'usage', tmpDir)).toBeNull();
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('findSectionContent failed'), expect.anything());
  });

  it('formats non-Error throws in the findSectionContent warning', () => {
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, opts?: any) => {
      if (typeof p === 'number') {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { code: 'EIO' }; // non-Error throw exercises the `instanceof Error` warn ternary
      }
      return realRead(p, opts);
    });
    expect(findSectionContent('docs/api.md', 'usage', tmpDir)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('findSectionContent failed'), { code: 'EIO' });
  });

  it('warns and returns null when the fd read fails with a non-ENOENT error', () => {
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, opts?: any) => {
      if (typeof p === 'number') {
        throw Object.assign(new Error('EIO: input/output error'), { code: 'EIO' });
      }
      return realRead(p, opts);
    });
    expect(findSectionContent('docs/api.md', 'usage', tmpDir)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('findSectionContent failed'), expect.anything());
  });

  // --- replaceSectionSignature guards ---

  it('reports when the file cannot be read or validated', () => {
    // The file exists (validatePath passes) but openAndValidate fails.
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const r = replaceSectionSignature({
      file: 'docs/api.md', anchor: 'usage', oldText: 'x', newText: 'y',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('could not read or validate file');
  });

  it('aligns LF texts to a CRLF file and keeps CRLF endings', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'crlf.md'),
      '## auth\r\n\r\n`login(\r\n  user: string\r\n)`\r\n',
      'utf-8',
    );
    const r = replaceSectionSignature({
      file: 'docs/crlf.md', anchor: 'auth',
      oldText: 'login(\n  user: string\n', newText: 'login(\n  user: string,\n  pass: string\n',
    }, tmpDir);
    expect(r.success).toBe(true);
    const after = fs.readFileSync(path.join(tmpDir, 'docs', 'crlf.md'), 'utf-8');
    expect(after).toContain('login(\r\n  user: string,\r\n  pass: string\r\n');
    expect(after).not.toContain('\n  user: string\r\n\n');
  });

  it('reports when the atomic write fails', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const r = replaceSectionSignature({
      file: 'docs/api.md', anchor: 'usage',
      oldText: 'login(user, pass)', newText: 'login(user, password, mfa)',
    }, tmpDir);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('atomic write failed');
  });
});

