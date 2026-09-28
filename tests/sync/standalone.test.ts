import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
