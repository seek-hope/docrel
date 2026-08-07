import { describe, it, expect } from 'vitest';
import { CodegraphClient } from '../../src/codegraph/client.js';

// Access the private parser for unit testing.
function parse(content: string) {
  const client = new CodegraphClient('definitely-not-used');
  return (client as any).parseExploreOutput(content) as {
    symbols: Array<{ name: string; kind: string; file: string; line: number; signature?: string }>;
    files: string[];
  };
}

// Verbatim-style sample of the CURRENT `codegraph serve --mcp` explore output.
const CURRENT_FORMAT = `**Exploration: symbols in packages/**

Found 3 symbols across 2 files.

**Blast radius — what depends on these (update/verify before editing)**

- \`SYMBOLS\` (packages/tui/src/latex.ts:3) — 1 caller in \`packages/tui/src/latex.ts\`; no covering tests found
- \`SymbolKey\` (packages/tui/src/keys.ts:76) — 1 caller in \`packages/tui/src/keys.ts\`; no covering tests found

**Relationships**

**references:**
- parseCommand → SYMBOLS
- parseCommand → PLAIN_WRAPPERS

**calls:**
- parseCommand → parseRequiredArgument

**Source Code**

**\`packages/tui/src/latex.ts\`** — SYMBOLS(constant), PLAIN_WRAPPERS(constant)

\`\`\`typescript
1	import { visibleWidth } from "./utils.ts";
2	
3	const SYMBOLS: Readonly<Record<string, string>> = {
4		alpha: "α",
5	};
\`\`\`

**\`packages/tui/src/keys.ts\`** — SymbolKey(type)

\`\`\`typescript
76	export type SymbolKey = string & { readonly __brand: 'SymbolKey' };
\`\`\`
`;

describe('parseExploreOutput — current codegraph format', () => {
  it('extracts symbols with file, line and kind from source headers + blast radius', () => {
    const { symbols, files } = parse(CURRENT_FORMAT);

    expect(files).toContain('packages/tui/src/latex.ts');
    expect(files).toContain('packages/tui/src/keys.ts');

    const sym = symbols.find((s) => s.name === 'SYMBOLS');
    expect(sym).toBeTruthy();
    expect(sym!.file).toBe('packages/tui/src/latex.ts');
    expect(sym!.line).toBe(3);
    expect(sym!.kind).toBe('constant');
    expect(sym!.signature).toContain('const SYMBOLS');

    const key = symbols.find((s) => s.name === 'SymbolKey');
    expect(key!.file).toBe('packages/tui/src/keys.ts');
    expect(key!.line).toBe(76);
    expect(key!.kind).toBe('type');
  });

  it('does NOT produce file-less symbols from the relationships section', () => {
    const { symbols } = parse(CURRENT_FORMAT);
    // parseCommand / parseRequiredArgument appear only in the relationships
    // lists — they must not become symbols at all.
    expect(symbols.find((s) => s.name === 'parseCommand')).toBeUndefined();
    expect(symbols.find((s) => s.name === 'parseRequiredArgument')).toBeUndefined();
    // And no symbol may have an empty file (the old ':0' garbage).
    expect(symbols.every((s) => s.file.length > 0)).toBe(true);
  });

  it('deduplicates symbols repeated across sections', () => {
    const dup = CURRENT_FORMAT + '\n- `SYMBOLS` (packages/tui/src/latex.ts:3) — 2 callers\n';
    const { symbols } = parse(dup);
    expect(symbols.filter((s) => s.name === 'SYMBOLS')).toHaveLength(1);
  });

  it('skips reference-listing entries and maps type_alias kinds (real pi-ex format)', () => {
    const realWorld = `**Exploration: symbols in packages/tui/src/**

**Blast radius — what depends on these (update/verify before editing)**

- \`SymbolKey\` (packages/tui/src/keys.ts:76) — 1 caller in \`packages/tui/src/keys.ts\`

**Source Code**

**\`packages/tui/src/keys.ts\`** — ModifiedKeyId(references), Letter(type_alias), SymbolKey(type_alias), SymbolKey(references)

\`\`\`typescript
76\ttype SymbolKey =
141\ttype BaseKey = Letter | Digit | SymbolKey | SpecialKey;
\`\`\`
`;
    const { symbols } = parse(realWorld);
    // 'references' entries are mention lists, not definitions — excluded.
    expect(symbols.find((s) => s.name === 'ModifiedKeyId')).toBeUndefined();
    // SymbolKey appears once, as a type_alias, at its blast-radius line.
    const sk = symbols.filter((s) => s.name === 'SymbolKey');
    expect(sk).toHaveLength(1);
    expect(sk[0].kind).toBe('type_alias');
    expect(sk[0].line).toBe(76);
    expect(sk[0].signature).toBe('type SymbolKey =');
    expect(symbols.find((s) => s.name === 'Letter')).toBeTruthy();
  });
});

describe('parseExploreOutput — legacy ## format fallback', () => {
  it('still parses older "## file" layouts', () => {
    const legacy = `## src/auth.ts\nexport function login(user) {}\n## src/util.ts\nexport class Helper {}\n`;
    const { symbols, files } = parse(legacy);
    expect(files).toEqual(['src/auth.ts', 'src/util.ts']);
    expect(symbols.find((s) => s.name === 'login')!.file).toBe('src/auth.ts');
    expect(symbols.find((s) => s.name === 'Helper')!.kind).toBe('class');
  });

  it('returns empty (CLI falls back to builtin) on unrecognized formats', () => {
    const { symbols, files } = parse('Some free-form prose with no structure at all.');
    expect(symbols).toHaveLength(0);
    expect(files).toHaveLength(0);
  });
});
