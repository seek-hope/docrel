// tests/tools/diff.test.ts
import { describe, it, expect } from 'vitest';
import { formatDiffMarkdown } from '../../src/tools/diff.js';

describe('formatDiffMarkdown', () => {
  it('outputs symbol header with signature', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(): void' },
      changeLog: [],
      affectedDocs: [],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('## DocRel Diff');
    expect(md).toContain('### Symbol: `login`');
    expect(md).toContain('**Signature:** `function login(): void`');
  });

  it('renders change log as markdown table', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(user: string): void' },
      changeLog: [
        {
          timestamp: '2025-01-15T10:00:00Z',
          change_type: 'signature',
          old_sig: 'function login(): void',
          new_sig: 'function login(user: string): void',
          sync_status: 'synced',
        },
      ],
      affectedDocs: [],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('### Change Log (1 entries)');
    expect(md).toContain('| Timestamp | Type | Old Signature | New Signature | Status |');
    expect(md).toContain('| 2025-01-15T10:00:00Z | signature |');
    expect(md).toContain('synced');
  });

  it('shows affected docs', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(): void' },
      changeLog: [],
      affectedDocs: [
        { file: 'docs/api.md', anchor: 'auth', status: 'stale' },
      ],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('### Affected Documentation (1)');
    expect(md).toContain('`docs/api.md#auth` — **stale**');
  });

  it('shows no-change-log message when empty', () => {
    const report = {
      symbol: { id: 'sym1', name: 'login', currentSignature: 'function login(): void' },
      changeLog: [],
      affectedDocs: [],
    };
    const md = formatDiffMarkdown(report);
    expect(md).toContain('_(no change log entries)_');
  });
});
