/**
 * Watertightness proof for the autoLink candidate prefilter (inverted
 * 4-gram index): on deterministic pseudo-random corpora, EVERY pair that
 * the brute-force scorers (fastScoreProfile / scoreProfile) would match
 * must appear in candidateSections() — for both passes and multiple
 * minConfidence values. If any bucket (exactMap / gramMap / always /
 * stemMap / brute fallbacks) lost coverage, links would silently vanish;
 * these tests fail instead.
 */
import { describe, it, expect } from 'vitest';
import { getDb, closeAllDbs } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/schema.js';
import { upsertSymbol, type SymbolRow } from '../../src/db/symbols.js';
import { upsertDocSection } from '../../src/db/docs.js';
import {
  autoLink,
  buildSymbolProfile,
  buildSectionProfile,
  buildSectionIndex,
  candidateSections,
  scoreProfile,
  fastScoreProfile,
} from '../../src/discovery/auto-linker.js';
import type { ParsedDocSection } from '../../src/discovery/doc-parser.js';
import { symbolId, docSectionId, contentHash } from '../../src/utils/hash.js';
import { listAllMappings } from '../../src/db/mappings.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Deterministic LCG so corpora are reproducible run-to-run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WORDS = [
  'login', 'user', 'auth', 'payment', 'session', 'token', 'cache', 'store',
  'query', 'render', 'parse', 'config', 'sync', 'watch', 'index', 'link',
  'doc', 'scan', 'hook', 'retry', 'queue', 'delta', 'merge', 'prune',
];

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

/** Generate a symbol name with a realistic mix of shapes. */
function randName(rnd: () => number): string {
  const shape = rnd();
  const words = () => {
    const n = 1 + Math.floor(rnd() * 3);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(pick(rnd, WORDS));
    return out;
  };
  if (shape < 0.30) { // camelCase
    const [w, ...rest] = words();
    return w + rest.map((x) => x[0].toUpperCase() + x.slice(1)).join('');
  }
  if (shape < 0.50) { // PascalCase
    return words().map((x) => x[0].toUpperCase() + x.slice(1)).join('');
  }
  if (shape < 0.65) return words().join('_'); // snake_case
  if (shape < 0.75) return pick(rnd, WORDS); // plain lowercase word
  if (shape < 0.82) return pick(rnd, WORDS).slice(0, 2 + Math.floor(rnd() * 2)); // 2-3 chars
  if (shape < 0.88) return '_' + pick(rnd, WORDS); // leading underscore
  if (shape < 0.93) return '$' + pick(rnd, WORDS); // non-word leading char
  if (shape < 0.97) return pick(rnd, WORDS) + Math.floor(rnd() * 100); // digits
  return '函数' + Math.floor(rnd() * 10); // non-ASCII (normalize() strips it)
}

interface Corpus {
  symbols: SymbolRow[];
  sections: ParsedDocSection[];
}

/** Build a corpus where some pairs are deliberately related through every
 *  rule type (word boundary, substring, each refType, fuzzy heading, fuzzy
 *  heading-ref, body-text, stem boost) and the rest are random noise. */
function genCorpus(rnd: () => number, nSym: number, nSec: number): Corpus {
  const symbols: SymbolRow[] = [];
  for (let i = 0; i < nSym; i++) {
    const name = randName(rnd);
    const location = `src/${pick(rnd, WORDS)}${i % 7 === 0 ? '/deep/nested' : ''}${i}.ts:${1 + i}`;
    symbols.push({
      id: symbolId('typescript', `${location}::${name}`, 'function'),
      name,
      kind: 'function',
      project: 'src',
      location,
      signature: 'sig' + i,
      raw_signature: `export function ${name}(a: number): void {`,
      metadata: '{}',
      created_at: '',
      updated_at: '',
    });
  }

  const sections: ParsedDocSection[] = [];
  for (let j = 0; j < nSec; j++) {
    const file = `docs/${pick(rnd, WORDS)}${j % 5 === 0 ? '/sub' : ''}${j}.md`;
    const codeRefs: ParsedDocSection['codeRefs'] = [];
    let heading: string;
    let content = 'Some prose about the system. ' + pick(rnd, WORDS) + ' happens here.';
    const relation = rnd();
    const target = symbols[Math.floor(rnd() * symbols.length)];
    const tName = target.name.replace(/\(.*\)$/, '');

    if (relation < 0.10 && tName.length >= 2) {
      heading = `The ${tName} workflow`; // R1 word-boundary plant
    } else if (relation < 0.16 && tName.length >= 3) {
      heading = `${tName}ification`; // R1b substring plant
    } else if (relation < 0.24) {
      heading = pick(rnd, WORDS);
      codeRefs.push({ refType: 'backtick', symbolName: target.name, confidence: 0.9, lineInDoc: 3 }); // refEq
    } else if (relation < 0.30) {
      heading = pick(rnd, WORDS);
      codeRefs.push({ refType: 'codeblock', symbolName: `${tName}(a)`, confidence: 0.7, lineInDoc: 4 }); // refEq cleaned
    } else if (relation < 0.36) {
      heading = pick(rnd, WORDS);
      codeRefs.push({ refType: 'heading', symbolName: tName, confidence: 0.6, lineInDoc: 1 }); // heading refEq
    } else if (relation < 0.42 && tName.length >= 5) {
      // fuzzy heading-ref: reversed halves share an LCS with the name
      const mid = Math.floor(tName.length / 2);
      codeRefs.push({ refType: 'heading', symbolName: tName.slice(mid) + tName.slice(0, mid), confidence: 0.6, lineInDoc: 1 });
      heading = pick(rnd, WORDS);
    } else if (relation < 0.48) {
      heading = pick(rnd, WORDS);
      codeRefs.push({ refType: 'bodytext', symbolName: tName, confidence: 0.4, lineInDoc: 5 }); // bodytext refEq
    } else if (relation < 0.56 && tName.length >= 5) {
      const mid = Math.floor(tName.length / 2);
      heading = tName.slice(mid) + ' ' + tName.slice(0, mid); // R4 fuzzy heading
    } else if (relation < 0.64 && /[A-Z_]/.test(tName)) {
      heading = 'Overview';
      content = `Mentions ${tName} inline in prose.`; // R6 body-text plant
    } else if (relation < 0.70) {
      heading = pick(rnd, WORDS).slice(0, 1 + Math.floor(rnd() * 2)); // 1-2 char heading
    } else if (relation < 0.76) {
      heading = ''; // preamble (empty anchor)
    } else if (relation < 0.82) {
      // stem-equal doc file for the boost path
      const stem = (target.location.split('/').pop() || 'x.ts').replace(/\.ts$/, '');
      heading = 'Notes';
      content = `Talks about ${tName} without being a heading.`;
      sections.push({ file: `docs/${stem}.md`, anchor: heading, content, codeRefs });
      continue;
    } else {
      heading = [pick(rnd, WORDS), pick(rnd, WORDS)].join(' ');
    }
    sections.push({ file, anchor: heading, content, codeRefs });
  }
  return { symbols, sections };
}

describe('autoLink candidate prefilter — watertightness', () => {
  for (const seed of [11, 222, 3333]) {
    it(`never drops a matchable pair (seed ${seed})`, () => {
      const { symbols, sections } = genCorpus(lcg(seed), 120, 60);
      const sps = symbols.map(buildSymbolProfile);
      const cps = sections.map(buildSectionProfile);
      const ix = buildSectionIndex(cps);

      for (const minConf of [0.5, 0.3]) {
        let pass1Checked = 0;
        let pass2Checked = 0;
        for (const sp of sps) {
          const cand1 = candidateSections(ix, sp, false, minConf);
          const cand2 = candidateSections(ix, sp, true, minConf);
          for (let j = 0; j < cps.length; j++) {
            // Pass 1: any fastScore match must be a candidate.
            if (fastScoreProfile(sp, cps[j]) > 0) {
              pass1Checked++;
              expect(cand1 === null || cand1.includes(j),
                `pass1 dropped ${sp.row.name} × section#${j} (${sections[j].file}#${sections[j].anchor})`).toBe(true);
            }
            // Pass 2: any full-score match must be a candidate.
            if (scoreProfile(sp, cps[j], minConf).matched) {
              pass2Checked++;
              expect(cand2 === null || cand2.includes(j),
                `pass2 dropped ${sp.row.name} × section#${j} (minConf=${minConf})`).toBe(true);
            }
          }
        }
        // The corpus must actually exercise matches, or the test proves nothing.
        expect(pass1Checked).toBeGreaterThan(0);
        expect(pass2Checked).toBeGreaterThan(0);
      }
    });
  }

  it('end-to-end: planted links of every rule type survive the filter', () => {
    const rnd = lcg(4242);
    const { symbols, sections } = genCorpus(rnd, 60, 40);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-alidx-'));
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    const db = getDb(tmpDir);
    try {
      runMigrations(db);
      for (const s of symbols) upsertSymbol(db, { ...s, metadata: {} });
      for (const sec of sections) {
        upsertDocSection(db, {
          id: docSectionId(sec.file, sec.anchor), file: sec.file, anchor: sec.anchor,
          content_hash: contentHash(sec.content), doc_type: 'standalone',
        });
      }

      // Brute-force expectation: replay the two-pass algorithm with the raw
      // scorers over ALL pairs (no filter) and compare mapping sets.
      const brute = bruteForceLinks(symbols, sections, 0.5);
      const res = autoLink(db, symbols, sections, 0.5);
      const got = new Set(listAllMappings(db).map((m) => `${m.symbol_id}::${m.doc_id}`));
      expect(got).toEqual(brute);
      expect(res.totalMatched).toBe(brute.size);

      // And at minConfidence 0.3 (exercises the codeLike brute bucket).
      const db2Path = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-alidx2-'));
      fs.mkdirSync(path.join(db2Path, '.git'), { recursive: true });
      const db2 = getDb(db2Path);
      try {
        runMigrations(db2);
        for (const s of symbols) upsertSymbol(db2, { ...s, metadata: {} });
        for (const sec of sections) {
          upsertDocSection(db2, {
            id: docSectionId(sec.file, sec.anchor), file: sec.file, anchor: sec.anchor,
            content_hash: contentHash(sec.content), doc_type: 'standalone',
          });
        }
        const brute3 = bruteForceLinks(symbols, sections, 0.3);
        autoLink(db2, symbols, sections, 0.3);
        expect(new Set(listAllMappings(db2).map((m) => `${m.symbol_id}::${m.doc_id}`))).toEqual(brute3);
      } finally {
        closeAllDbs();
        fs.rmSync(db2Path, { recursive: true, force: true });
      }
    } finally {
      closeAllDbs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/** Reference implementation of the two-pass algorithm without any filter. */
function bruteForceLinks(symbols: SymbolRow[], sections: ParsedDocSection[], minConf: number): Set<string> {
  const sps = symbols.map(buildSymbolProfile);
  const cps = sections.map(buildSectionProfile);
  const out = new Set<string>();
  const linked = new Set<string>();
  for (const sp of sps) {
    for (const cp of cps) {
      if (fastScoreProfile(sp, cp) > 0) {
        out.add(`${sp.row.id}::${docSectionId(cp.section.file, cp.section.anchor)}`);
        linked.add(sp.row.id);
      }
    }
  }
  for (const sp of sps) {
    if (linked.has(sp.row.id)) continue;
    for (const cp of cps) {
      if (scoreProfile(sp, cp, minConf).matched) {
        out.add(`${sp.row.id}::${docSectionId(cp.section.file, cp.section.anchor)}`);
      }
    }
  }
  return out;
}

describe('candidateSections bucket targeting', () => {
  const sym = (name: string, location = 'src/alpha.ts:1'): SymbolRow => ({
    id: symbolId('typescript', `${location}::${name}`, 'function'),
    name, kind: 'function', project: 'src', location,
    signature: 's', raw_signature: `export function ${name}(): void {`,
    metadata: '{}', created_at: '', updated_at: '',
  });
  const sec = (file: string, anchor: string, content = '', codeRefs: ParsedDocSection['codeRefs'] = []): ParsedDocSection =>
    ({ file, anchor, content, codeRefs });

  it('falls back to all sections for sub-4-char normalized names', () => {
    const sp = buildSymbolProfile(sym('get'));
    const ix = buildSectionIndex([buildSectionProfile(sec('docs/a.md', 'Getting Started'))]);
    expect(candidateSections(ix, sp, false, 0.5)).toBeNull();
    expect(candidateSections(ix, sp, true, 0.5)).toBeNull();
  });

  it('falls back to all sections for names normalize() strips to nothing', () => {
    const sp = buildSymbolProfile(sym('函数'));
    const ix = buildSectionIndex([buildSectionProfile(sec('docs/a.md', 'Anything'))]);
    expect(candidateSections(ix, sp, true, 0.5)).toBeNull();
  });

  it('falls back to all sections for codeLike symbols when minConfidence ≤ 0.4', () => {
    const sp = buildSymbolProfile(sym('getUser'));
    const ix = buildSectionIndex([buildSectionProfile(sec('docs/a.md', 'Zebra'))]);
    expect(candidateSections(ix, sp, true, 0.4)).toBeNull();
    expect(candidateSections(ix, sp, true, 0.3)).toBeNull();
    // …but pass 1 has no content rule, so it still filters.
    expect(candidateSections(ix, sp, false, 0.3)).not.toBeNull();
    // …and minConfidence > 0.4 needs the stem boost, so it filters too.
    expect(candidateSections(ix, sp, true, 0.5)).not.toBeNull();
  });

  it('routes short-heading sections through the always bucket', () => {
    const cps = [
      buildSectionProfile(sec('docs/a.md', 'Go')),       // 2-char headingNorm
      buildSectionProfile(sec('docs/b.md', 'Long heading here')),
      buildSectionProfile(sec('docs/c.md', '', 'preamble')), // empty — NOT always
    ];
    const ix = buildSectionIndex(cps);
    expect(ix.always).toEqual([0]);
    const sp = buildSymbolProfile(sym('golang'));
    const cand = candidateSections(ix, sp, true, 0.5)!;
    expect(cand).toContain(0);
  });

  it('finds content-only mentions through the stem bucket at minConfidence 0.5', () => {
    // Symbol mentioned ONLY in content (no heading/ref match): 0.4 needs the
    // +0.1 stem boost → the pair must arrive via stemMap.
    const sp = buildSymbolProfile(sym('getUserProfile', 'src/auth.ts:3'));
    const cps = [buildSectionProfile(sec('docs/auth.md', 'Overview', 'Calls getUserProfile here.'))];
    const ix = buildSectionIndex(cps);
    const cand = candidateSections(ix, sp, true, 0.5)!;
    expect(cand).toContain(0);
    expect(scoreProfile(sp, cps[0], 0.5).matched).toBe(true);
    // Pass 1 must NOT include it (fastScore has no 0.4 rules to boost).
    expect(candidateSections(ix, sp, false, 0.5)!.includes(0)).toBe(false);
  });

  it('matches every refType through exactMap', () => {
    const s = sym('loginUser');
    const sp = buildSymbolProfile(s);
    const cps = (['backtick', 'codeblock', 'heading', 'bodytext'] as const).map((t, i) =>
      buildSectionProfile(sec(`docs/${i}.md`, 'Unrelated Heading', '', [{ refType: t, symbolName: 'loginUser', confidence: 0.9, lineInDoc: 2 }])));
    const ix = buildSectionIndex(cps);
    const cand = candidateSections(ix, sp, true, 0.5)!;
    for (let i = 0; i < 4; i++) expect(cand).toContain(i);
  });

  it('indexes the call-stripped ref spelling as well as the raw one', () => {
    const sp = buildSymbolProfile(sym('loginUser'));
    const cps = [buildSectionProfile(sec('docs/a.md', 'Ref guide', '', [{ refType: 'backtick', symbolName: 'loginUser(a, b)', confidence: 0.9, lineInDoc: 2 }]))];
    const ix = buildSectionIndex(cps);
    expect(candidateSections(ix, sp, true, 0.5)!).toContain(0);
  });
});
