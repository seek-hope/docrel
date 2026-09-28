import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validatePath, escapeRegex, escapeLike, escapeRegexGlobal } from '../../src/utils/fs.js';

describe('validatePath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-fsutil-'));
    fs.writeFileSync(path.join(tmpDir, 'real.md'), '# Real\n', 'utf-8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects an empty or whitespace project root', () => {
    expect(validatePath('a.md', '')).toBeNull();
    expect(validatePath('a.md', '   ')).toBeNull();
  });

  it('rejects an empty file path (would resolve to the root itself)', () => {
    expect(validatePath('', tmpDir)).toBeNull();
    expect(validatePath('  ', tmpDir)).toBeNull();
  });

  it('rejects paths that escape the project root', () => {
    expect(validatePath('../outside.md', tmpDir)).toBeNull();
    expect(validatePath('/etc/hostname', tmpDir)).toBeNull();
  });

  it('rejects a symlink that resolves outside the project root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-out-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'x', 'utf-8');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(tmpDir, 'link.md'));
    expect(validatePath('link.md', tmpDir)).toBeNull();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a dangling symlink even though the target does not exist', () => {
    fs.symlinkSync(path.join(tmpDir, 'gone.md'), path.join(tmpDir, 'dangling.md'));
    expect(validatePath('dangling.md', tmpDir)).toBeNull();
  });

  it('accepts a normal in-project file and returns the resolved path', () => {
    expect(validatePath('real.md', tmpDir)).toBe(path.join(tmpDir, 'real.md'));
  });

  it('rejects a not-yet-existing path — validation applies to existing files only', () => {
    // Contract: realpath fails (ENOENT) → lstat fails (ENOENT) → null.
    // Callers that create new files must use their own containment checks;
    // validatePath only vouches for paths that already exist on disk.
    expect(validatePath('new-file.md', tmpDir)).toBeNull();
  });
});

describe('escapeRegex / escapeLike / escapeRegexGlobal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('escapeRegex neutralizes all regex metacharacters', () => {
    const raw = 'a.b*c+d?e^f$g{h}(i)[j]k|l\\m';
    const re = new RegExp(`^${escapeRegex(raw)}$`);
    expect(re.test(raw)).toBe(true);
    expect(re.test('aXbXc')).toBe(false);
  });

  it('escapeLike escapes %, _, and the escape character itself', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('c:\\path')).toBe('c:\\\\path');
  });

  it('escapeRegexGlobal returns a working global regex for normal input', () => {
    const re = escapeRegexGlobal('a.b');
    expect(re).not.toBeNull();
    expect('a.b aXb a.b'.match(re!)).toEqual(['a.b', 'a.b']);
  });

  it('escapeRegexGlobal returns null with a warning for oversized input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(escapeRegexGlobal('x'.repeat(201))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds max'));
  });
});
