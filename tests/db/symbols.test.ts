import { describe, it, expect } from 'vitest';
import { symbolId, docSectionId } from '../../src/utils/hash.js';
import crypto from 'node:crypto';

describe('symbolId', () => {
  it('generates a stable 64-char hex string', () => {
    const id = symbolId('typescript', 'src/auth::login', 'function');
    expect(id).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(id)).toBe(true);
  });

  it('is deterministic — same inputs produce same id', () => {
    const a = symbolId('typescript', 'src/auth::login', 'function');
    const b = symbolId('typescript', 'src/auth::login', 'function');
    expect(a).toBe(b);
  });

  it('differs when language differs', () => {
    const ts = symbolId('typescript', 'login', 'function');
    const py = symbolId('python', 'login', 'function');
    expect(ts).not.toBe(py);
  });

  it('differs when kind differs', () => {
    const fn = symbolId('typescript', 'login', 'function');
    const cls = symbolId('typescript', 'login', 'class');
    expect(fn).not.toBe(cls);
  });

  it('normalizes FQN whitespace', () => {
    const a = symbolId('typescript', '  src/auth::login  ', 'function');
    const b = symbolId('typescript', 'src/auth::login', 'function');
    expect(a).toBe(b);
  });
});

describe('docSectionId', () => {
  it('generates a stable 64-char hex string', () => {
    const id = docSectionId('docs/api.md', 'authentication');
    expect(id).toHaveLength(64);
  });

  it('is deterministic', () => {
    const a = docSectionId('docs/api.md', 'authentication');
    const b = docSectionId('docs/api.md', 'authentication');
    expect(a).toBe(b);
  });
});
