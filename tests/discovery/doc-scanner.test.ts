import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanDocs } from '../../src/discovery/doc-scanner.js';

describe('scanDocs missing-path handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-docscan-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports nonexistent configured paths as skippedMissing, not failedFiles', async () => {
    const { report } = await scanDocs(['docs', 'README.md'], tmpDir);
    expect(report.skippedMissing).toEqual(['docs', 'README.md']);
    expect(report.failedFiles).toEqual([]);
  });

  it('still parses existing dirs while skipping missing ones', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs'));
    fs.writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '# Title\n\nSome content.\n');
    const { sections, report } = await scanDocs(['docs', 'missing-dir'], tmpDir);
    expect(report.skippedMissing).toEqual(['missing-dir']);
    expect(report.failedFiles).toEqual([]);
    expect(sections.length).toBeGreaterThan(0);
  });
});
