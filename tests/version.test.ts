/**
 * The version lives in two places by design: package.json (npm metadata)
 * and src/version.ts (runtime banner/MCP health). They must never drift —
 * release.yml checks tag↔package.json, this test closes the remaining gap.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { DOCRELAY_VERSION } from '../src/version.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

describe('version sync', () => {
  it('DOCRELAY_VERSION matches package.json version', () => {
    expect(DOCRELAY_VERSION).toBe(pkg.version);
  });
});
