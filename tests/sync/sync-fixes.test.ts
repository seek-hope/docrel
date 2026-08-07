import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol } from '../../src/db/symbols.js';
import { upsertDocSection, getDocSection, markDocStale } from '../../src/db/docs.js';
import { createMapping } from '../../src/db/mappings.js';
import { syncSymbol } from '../../src/sync/engine.js';
import { findSectionContentFromString } from '../../src/sync/standalone.js';
import { docrelayCheck } from '../../src/tools/check.js';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';
import type { DocRelayConfig } from '../../src/utils/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Strategies used to exercise the standalone auto_update rewrite.
const autoConfig: DocRelayConfig = {
  project: 'test',
  doc_dirs: ['docs'],
  code_dirs: ['src'],
  strategies: {
    inline: 'auto_update',
    standalone: 'auto_update',
    generated: 'auto_update',
    architecture: 'mark_stale',
  },
};

describe('sync fixes', () => {
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let symId: string;
  let docId: string;

  const OLD_SIG = 'export function login(user: string): User';
  const NEW_SIG = 'export function login(user: string): Promise<User>';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-syncfix-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    db = getDb(tmpDir);
    runMigrations(db);
    symId = symbolId('typescript', 'src/auth::login', 'function');
  });

  afterEach(() => {
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('standalone auto_update actually rewrites the document and refreshes the hash', async () => {
    // Source file now carries the NEW signature (code changed on disk).
    fs.writeFileSync(
      path.join(tmpDir, 'src/auth.ts'),
      `export function login(user: string): Promise<User> {\n  return Promise.resolve({ user });\n}\n`,
    );

    // Markdown doc — the authentication section still documents the OLD signature.
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'api.md'),
      [
        '# Authentication',
        '',
        'The `login` function authenticates a user.',
        '',
        '```ts',
        OLD_SIG,
        '```',
        '',
        '## Other',
        '',
        'Unrelated section stays untouched.',
        '',
      ].join('\n'),
    );

    // The doc-parser anchors a heading section by its verbatim heading text
    // (e.g. 'Authentication'), and a preamble section by the empty string.
    docId = docSectionId('docs/api.md', 'Authentication');
    const fileContent = fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8');
    const sectionContent = findSectionContentFromString(fileContent, 'Authentication');
    // Pre-scan state: raw_signature still holds the OLD documented signature.
    upsertSymbol(db, {
      id: symId,
      name: 'login',
      kind: 'function',
      location: 'src/auth.ts:1',
      signature: contentHash(OLD_SIG),
      raw_signature: OLD_SIG,
    });
    upsertDocSection(db, {
      id: docId,
      file: 'docs/api.md',
      anchor: 'Authentication',
      doc_type: 'standalone',
      content_hash: contentHash(sectionContent ?? ''),
      status: 'stale',
    });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.docsUpdated).toContain('docs/api.md');
    expect(result.errors).toHaveLength(0);

    // File content updated: the old documented signature is replaced by the new one.
    const written = fs.readFileSync(path.join(tmpDir, 'docs', 'api.md'), 'utf-8');
    expect(written).toContain(NEW_SIG);
    expect(written).not.toContain(OLD_SIG);

    const doc = getDocSection(db, docId);
    expect(doc!.status).toBe('in_sync');
    const newHarmonized = findSectionContentFromString(written, 'Authentication');
    expect(newHarmonized).not.toBeNull();
    expect(doc!.content_hash).toBe(contentHash(newHarmonized ?? ''));
  });

  it('locates and syncs an empty-anchor (preamble) section', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src/auth.ts'),
      `export function login(user: string): Promise<User> {\n  return Promise.resolve({ user });\n}\n`,
    );

    // Preamble before the first heading carries the OLD signature.
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'readme.md'),
      [
        'This is the preamble.',
        '',
        '```ts',
        OLD_SIG,
        '```',
        '',
        '# First Heading',
        '',
        'Body belongs to a different section.',
        '',
      ].join('\n'),
    );

    docId = docSectionId('docs/readme.md', '');
    upsertSymbol(db, {
      id: symId,
      name: 'login',
      kind: 'function',
      location: 'src/auth.ts:1',
      signature: contentHash(OLD_SIG),
      raw_signature: OLD_SIG,
    });
    upsertDocSection(db, {
      id: docId,
      file: 'docs/readme.md',
      anchor: '',
      doc_type: 'standalone',
      content_hash: 'stale-entry',
      status: 'stale',
    });
    createMapping(db, { symbol_id: symId, doc_id: docId, rel_type: 'describes' });

    const result = await syncSymbol(db, autoConfig, symId, tmpDir);

    expect(result.docsUpdated).toContain('docs/readme.md');
    const written = fs.readFileSync(path.join(tmpDir, 'docs', 'readme.md'), 'utf-8');
    expect(written).toContain(NEW_SIG);
    expect(written).not.toContain(OLD_SIG);

    const doc = getDocSection(db, docId);
    expect(doc!.status).toBe('in_sync');
  });

  it('check reports passed=false in non-strict mode when docs are stale', () => {
    docId = docSectionId('docs/api.md', 'auth');
    upsertDocSection(db, {
      id: docId,
      file: 'docs/api.md',
      anchor: 'auth',
      doc_type: 'standalone',
      status: 'in_sync',
    });
    markDocStale(db, docId);

    // Non-strict: passed reflects the TRUE stale state (no longer always true).
    const report = docrelayCheck(db, false);
    expect(report.passed).toBe(false);
    expect(report.staleDocs).toHaveLength(1);
  });
});
