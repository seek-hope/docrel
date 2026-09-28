/**
 * Connection-plumbing coverage for CodegraphClient: liveness guards and
 * retry paths (via an injected fake MCP client), doConnect's binary
 * resolution/validation pipeline (via fake binaries on PATH), the SDK
 * connect flow (via a mocked SDK), isAvailable fallbacks, and parse edge
 * paths (dedup, blast-radius recovery, truncation, malformed sections).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodegraphClient } from '../../src/codegraph/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ── SDK mock: doConnect constructs Client/StdioClientTransport ── */

const sdkMock = vi.hoisted(() => ({
  connectImpl: { current: (_transport: unknown): Promise<void> => Promise.resolve() },
  lastClient: null as { close: ReturnType<typeof vi.fn> } | null,
  lastTransportOpts: null as Record<string, unknown> | null,
  lastTransport: null as { stderr: import('node:stream').PassThrough } | null,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    close = vi.fn().mockResolvedValue(undefined);
    callTool = vi.fn().mockResolvedValue({ isError: false, content: [] });
    constructor() { sdkMock.lastClient = this; }
    connect(transport: unknown): Promise<void> { return sdkMock.connectImpl.current(transport); }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async () => {
  const { PassThrough } = await import('node:stream');
  return {
    StdioClientTransport: class {
      stderr = new PassThrough();
      constructor(opts: unknown) {
        sdkMock.lastTransportOpts = opts as Record<string, unknown>;
        sdkMock.lastTransport = this;
      }
    },
  };
});

// client.ts resolves fs via `await import('node:fs')` — spying on the CJS
// default export does not reach the namespace copy, so statSync is mocked at
// the module level (passthrough by default; tests override per case).
const fsMock = vi.hoisted(() => ({
  realStatSync: null as unknown as typeof import('node:fs').statSync,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.realStatSync = actual.statSync;
  const statSync = vi.fn(actual.statSync);
  // the default import (`import fs from 'node:fs'`) resolves to the module's
  // `default` key, so patch it with the SAME mock to keep both views in sync
  return { ...actual, statSync, default: { ...actual, statSync } };
});

/* ── shared helpers ── */

interface FakeMcp { callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

interface Poke {
  client: unknown;
  livenessInProgress: boolean;
  connectPromise: Promise<void> | null;
  connectGeneration: number;
  _preflightResult: string | null | undefined;
  serverStderrTail: string[];
}
const poke = (cg: CodegraphClient): Poke => cg as unknown as Poke;

const ok = { isError: false, content: [] };

function fakeMcp(handler: (name: string) => unknown): FakeMcp {
  return {
    callTool: vi.fn().mockImplementation((params: { name: string }) => Promise.resolve(handler(params.name))),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── liveness guards (injected client) ── */

describe('connect liveness guards', () => {
  it('returns the in-flight connectPromise when liveness is already running', async () => {
    const cg = new CodegraphClient('unused');
    poke(cg).client = fakeMcp(() => ok);
    poke(cg).livenessInProgress = true;
    const inFlight = Promise.resolve();
    poke(cg).connectPromise = inFlight;

    await cg.connect();
    // The in-flight promise was awaited as-is — no new liveness check ran.
    expect(poke(cg).client).not.toBeNull();
    expect((poke(cg).client as FakeMcp).callTool).not.toHaveBeenCalled();
  });

  it('polls for an in-progress liveness check with no connectPromise, then connects', async () => {
    const cg = new CodegraphClient('unused');
    const fake = fakeMcp(() => ok);
    poke(cg).client = fake;
    poke(cg).livenessInProgress = true;
    poke(cg).connectPromise = null;
    setTimeout(() => { poke(cg).livenessInProgress = false; }, 30);

    await cg.connect();
    // After the poll, the recursive connect() ran the normal liveness check.
    expect(fake.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codegraph_status' }), undefined, expect.anything(),
    );
  });

  it('retries once when the liveness call reports isError, then stays connected', async () => {
    const cg = new CodegraphClient('unused');
    let statusCalls = 0;
    const fake = fakeMcp((name) => {
      if (name === 'codegraph_status') {
        statusCalls++;
        return statusCalls === 1 ? { isError: true, content: [] } : ok;
      }
      return { content: [{ type: 'text', text: '' }] };
    });
    poke(cg).client = fake;

    await cg.connect();
    expect(statusCalls).toBe(2);
    await expect(cg.search('x')).resolves.toBeDefined();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('retries once when the liveness call throws, then stays connected', async () => {
    const cg = new CodegraphClient('unused');
    let statusCalls = 0;
    const fake: FakeMcp = {
      callTool: vi.fn().mockImplementation((params: { name: string }) => {
        if (params.name === 'codegraph_status') {
          statusCalls++;
          if (statusCalls === 1) return Promise.reject(new Error('transient'));
          return Promise.resolve(ok);
        }
        return Promise.resolve({ content: [] });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    poke(cg).client = fake;

    await cg.connect();
    expect(statusCalls).toBe(2);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('discards the client when the liveness retry also reports isError', async () => {
    const cg = new CodegraphClient('definitely-missing-binary');
    const fake = fakeMcp(() => ({ isError: true, content: [] }));
    poke(cg).client = fake;

    // Liveness fails twice → client closed and discarded → doConnect fails
    // because the binary does not exist.
    await expect(cg.explore('x')).rejects.toThrow();
    expect(fake.callTool).toHaveBeenCalledTimes(2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(poke(cg).client).toBeNull();
  });

  it('throws when connect() resolves but the client was nulled concurrently', async () => {
    const cg = new CodegraphClient('unused');
    const fake = fakeMcp(() => {
      // A concurrent isAvailable() failure path nulls the client mid-connect.
      poke(cg).client = null;
      return ok;
    });
    poke(cg).client = fake;

    await expect(cg.explore('x')).rejects.toThrow('Codegraph client is not connected');
  });
});

/* ── doConnect binary validation (rejected before any spawn) ── */

describe('doConnect binary validation', () => {
  it('rejects commands with shell metacharacters', async () => {
    const cg = new CodegraphClient('bad;cmd');
    await expect(cg.connect()).rejects.toThrow('Invalid codegraph command');
  });

  it('rejects relative command paths', async () => {
    const cg = new CodegraphClient('./rel/codegraph');
    await expect(cg.connect()).rejects.toThrow('Relative paths are not allowed');
  });
});

describe('doConnect binary pipeline (fake binaries on PATH)', () => {
  let tmpDir: string;
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cgconn-'));
    // .npm/ in the path satisfies the allowed-prefix validation.
    binDir = path.join(tmpDir, '.npm', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(fs.statSync).mockImplementation(fsMock.realStatSync);
  });

  function fakeBinary(name: string, script: string): string {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, script, { mode: 0o755 });
    return p;
  }

  it('rejects when which returns an empty resolution', async () => {
    fakeBinary('which', '#!/bin/sh\nexit 0\n');
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('not found in PATH');
  });

  it('rejects when the resolved path is not a regular file', async () => {
    const dir = path.join(binDir, 'fakedir');
    fs.mkdirSync(dir);
    fakeBinary('which', `#!/bin/sh\necho '${dir}'\n`);
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('non-file');
  });

  it('rejects when the binary vanishes before the stat check', async () => {
    fakeBinary('codegraph', '#!/bin/sh\nexit 0\n');
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      if (String(p).includes('.npm')) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      }
      return fsMock.realStatSync(p);
    });
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('binary not found at');
  });

  it('rejects when the stat check fails for another reason', async () => {
    fakeBinary('codegraph', '#!/bin/sh\nexit 0\n');
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      if (String(p).includes('.npm')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return fsMock.realStatSync(p);
    });
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('Cannot stat codegraph binary');
  });

  it('rejects a resolution outside the allowed installation prefixes', async () => {
    const evil = path.join(tmpDir, 'evil-codegraph');
    fs.writeFileSync(evil, '#!/bin/sh\n', { mode: 0o755 });
    fakeBinary('which', `#!/bin/sh\necho '${evil}'\n`);
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('unexpected path');
  });

  it('refuses to spawn when the binary is swapped after resolution (TOCTOU)', async () => {
    fakeBinary('codegraph', '#!/bin/sh\nexit 0\n');
    let calls = 0;
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      const st = fsMock.realStatSync(p);
      if (String(p).includes('.npm')) {
        calls++;
        if (calls === 2) return { ...st, ino: st.ino + 1 };
      }
      return st;
    });
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('modified after resolution');
  });
});

/* ── doConnect SDK flow (mocked SDK + real fake binary) ── */

describe('doConnect SDK flow', () => {
  let tmpDir: string;
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cgsdk-'));
    binDir = path.join(tmpDir, '.npm', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    sdkMock.connectImpl.current = () => Promise.resolve();
    sdkMock.lastClient = null;
    sdkMock.lastTransportOpts = null;
    sdkMock.lastTransport = null;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs the client on a successful connect and serves tool calls', async () => {
    const cg = new CodegraphClient('codegraph');
    await cg.connect();
    expect(sdkMock.lastClient).not.toBeNull();
    await expect(cg.search('anything')).resolves.toBeDefined();
  });

  it('spawns the codegraph server rooted at the configured project cwd', async () => {
    // The server resolves its .codegraph/ index from its own working
    // directory — without an explicit cwd, a docrelay process running inside
    // a DIFFERENT indexed project (MCP hosts, DOCRELAY_PROJECT_ROOT
    // overrides) would silently ingest that project's symbols.
    const cg = new CodegraphClient('codegraph', '/data/my-project');
    await cg.connect();
    expect(sdkMock.lastTransportOpts?.cwd).toBe('/data/my-project');
  });

  it('leaves the server cwd at the process default when no root is configured', async () => {
    const cg = new CodegraphClient('codegraph');
    await cg.connect();
    expect(sdkMock.lastTransportOpts?.cwd).toBeUndefined();
  });

  it('surfaces the real connect error (not a timeout)', async () => {
    sdkMock.connectImpl.current = () => Promise.reject(new Error('handshake exploded'));
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('handshake exploded');
    expect(sdkMock.lastClient!.close).toHaveBeenCalled();
  });

  it('pipes server stderr into a tail buffer surfaced on connect failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reject on setImmediate (not synchronously) so the stderr write below
    // deterministically lands in the tail buffer before the catch prints it.
    sdkMock.connectImpl.current = () => new Promise<void>((_, rej) => setImmediate(() => rej(new Error('handshake exploded'))));
    const cg = new CodegraphClient('codegraph');
    const pending = cg.connect().catch((e) => e);
    // doConnect constructs the transport after several awaits — spin until it exists.
    for (let i = 0; i < 50 && !sdkMock.lastTransport; i++) await new Promise((r) => setImmediate(r));
    expect(sdkMock.lastTransportOpts?.stderr).toBe('pipe');
    sdkMock.lastTransport!.stderr.write('[CodeGraph MCP] fatal: index corrupt\n');
    await pending;
    // …and the buffered tail surfaces as one diagnostic warning.
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('codegraph server output before connect failure') && String(c[0]).includes('index corrupt'))).toBe(true);
  });

  it('does not forward server stderr on a successful connect', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cg = new CodegraphClient('codegraph');
    const pending = cg.connect();
    for (let i = 0; i < 50 && !sdkMock.lastTransport; i++) await new Promise((r) => setImmediate(r));
    sdkMock.lastTransport!.stderr.write('[CodeGraph MCP] No .codegraph/ at or above /x: no default project\n');
    await pending;
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('No .codegraph'))).toBe(false);
  });

  it('echoes server stderr lines via console.debug under DOCRELAY_DEBUG', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const savedDebug = process.env.DOCRELAY_DEBUG;
    process.env.DOCRELAY_DEBUG = '1';
    try {
      const cg = new CodegraphClient('codegraph');
      const pending = cg.connect();
      for (let i = 0; i < 50 && !sdkMock.lastTransport; i++) await new Promise((r) => setImmediate(r));
      sdkMock.lastTransport!.stderr.write('server says hello\n');
      await pending;
      expect(debugSpy).toHaveBeenCalledWith('DocRelay: codegraph server:', 'server says hello');
    } finally {
      if (savedDebug === undefined) delete process.env.DOCRELAY_DEBUG;
      else process.env.DOCRELAY_DEBUG = savedDebug;
    }
  });

  it('caps the stderr tail at 20 lines, joining partial lines and skipping blanks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sdkMock.connectImpl.current = () => new Promise<void>((_, rej) => setImmediate(() => rej(new Error('boom'))));
    const cg = new CodegraphClient('codegraph');
    const pending = cg.connect().catch((e) => e);
    for (let i = 0; i < 50 && !sdkMock.lastTransport; i++) await new Promise((r) => setImmediate(r));
    const stderr = sdkMock.lastTransport!.stderr;
    for (let i = 1; i <= 20; i++) stderr.write(`line ${i}\n`);
    stderr.write('\n'); // blank lines are skipped entirely
    // A partial line only flushes once a later chunk completes it.
    stderr.write('partial-line');
    stderr.write(' completed\n');
    await pending;
    expect(poke(cg).serverStderrTail).toHaveLength(20);
    expect(poke(cg).serverStderrTail[0]).toBe('line 2'); // 'line 1' evicted by the 21st push
    expect(poke(cg).serverStderrTail[19]).toBe('partial-line completed');
    // The failure warning shows only the last 5 buffered lines.
    const warning = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('server output before connect failure'));
    expect(warning).toContain('partial-line completed');
    expect(warning).toContain('line 17');
    expect(warning).not.toContain('line 16');
  });

  it('times out a hanging connect and closes the half-open client', async () => {
    sdkMock.connectImpl.current = () => new Promise<void>(() => { /* never settles */ });
    const cg = new CodegraphClient('codegraph');
    await expect(cg.connect()).rejects.toThrow('connect timed out');
    expect(sdkMock.lastClient!.close).toHaveBeenCalled();
  }, 15_000);

  it('discards the new client when a newer generation started mid-connect', async () => {
    sdkMock.connectImpl.current = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
    const cg = new CodegraphClient('codegraph');
    const connecting = cg.connect();
    await new Promise((r) => setTimeout(r, 30));
    poke(cg).connectGeneration++;
    await connecting;
    expect(sdkMock.lastClient!.close).toHaveBeenCalled();
    expect(poke(cg).client).toBeNull();
  });
});

/* ── isAvailable fallbacks ── */

describe('isAvailable', () => {
  it('warns and returns false when preflight reports an issue', async () => {
    const cg = new CodegraphClient('unused');
    poke(cg)._preflightResult = 'some preflight issue';
    await expect(cg.isAvailable()).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('some preflight issue'));
  });

  it('returns false when preflight itself throws', async () => {
    const cg = new CodegraphClient('unused');
    vi.spyOn(cg, 'preflight').mockRejectedValue(new Error('preflight exploded'));
    await expect(cg.isAvailable()).resolves.toBe(false);
  });

  it('returns true when preflight passes and connect succeeds', async () => {
    const cg = new CodegraphClient('unused');
    poke(cg)._preflightResult = null;
    poke(cg).client = fakeMcp(() => ok);
    await expect(cg.isAvailable()).resolves.toBe(true);
  });

  it('closes and discards the client when connect fails', async () => {
    const cg = new CodegraphClient('bad;cmd');
    const fake: FakeMcp = {
      callTool: vi.fn().mockRejectedValue(new Error('process gone')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    poke(cg)._preflightResult = null;
    poke(cg).client = fake;

    await expect(cg.isAvailable()).resolves.toBe(false);
    expect(fake.close).toHaveBeenCalled();
    expect(poke(cg).client).toBeNull();
  });
});

/* ── parse edge paths ── */

describe('explore parse edge paths', () => {
  function exploring(content: string): CodegraphClient {
    const cg = new CodegraphClient('unused');
    poke(cg).client = fakeMcp((name) =>
      name === 'codegraph_status' ? ok : { content: [{ type: 'text', text: content }] });
    return cg;
  }

  it('skips malformed kind entries in a section header and warns on files-without-symbols', async () => {
    const cg = exploring('**`src/a.ts`** — brokenkind\n');
    const result = await cg.explore('x');
    expect(result.symbols).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('1 files but 0 symbols'));
  });

  it('deduplicates a symbol repeated across two sections for the same file', async () => {
    const content = [
      '**`src/a.ts`** — login(function)',
      '',
      '```typescript',
      '9\texport function login(user: string): boolean {',
      '```',
      '',
      '**`src/a.ts`** — login(function)',
      '',
      '```typescript',
      '9\texport function login(user: string): boolean {',
      '```',
    ].join('\n');
    const cg = exploring(content);
    const result = await cg.explore('x');
    expect(result.symbols.filter((s) => s.name === 'login')).toHaveLength(1);
  });

  it('ignores blast-radius bullets for files without a source section', async () => {
    const content = [
      '- `dep` (src/other.ts:5) — 2 callers in `src/a.ts`',
      '',
      '**`src/a.ts`** — login(function)',
      '',
      '```typescript',
      '9\texport function login(user: string): boolean {',
      '```',
    ].join('\n');
    const cg = exploring(content);
    const result = await cg.explore('x');
    expect(result.symbols.map((s) => s.name)).toEqual(['login']);
  });

  it('recovers a truncated-header symbol from the blast radius via the definition line', async () => {
    const content = [
      '- `recover` (src/a.ts:0) — 1 caller in `src/b.ts`',
      '',
      '**`src/a.ts`** — login(function)',
      '',
      '```typescript',
      '3\texport function recover(key: string): boolean {',
      '9\texport function login(user: string): boolean {',
      '```',
    ].join('\n');
    const cg = exploring(content);
    const result = await cg.explore('x');
    const recovered = result.symbols.find((s) => s.name === 'recover');
    expect(recovered).toMatchObject({ file: 'src/a.ts', line: 3 });
  });

  it('parses line-number prefixes in the legacy ## format', async () => {
    const content = '## src/legacy.ts\n\n42 | export function old(x) {\n';
    const cg = exploring(content);
    const result = await cg.explore('x');
    expect(result.symbols).toEqual([expect.objectContaining({ name: 'old', line: 42 })]);
  });

  it('deduplicates a repeated definition within the legacy ## format', async () => {
    const content = '## src/a.ts\n1 | function foo() {}\n2 | function foo() {}\n';
    const cg = exploring(content);
    const result = await cg.explore('x');
    expect(result.symbols).toEqual([expect.objectContaining({ name: 'foo', file: 'src/a.ts', line: 1 })]);
  });

  it('ignores non-numbered lines inside a source fence', async () => {
    const content = [
      '**`src/a.ts`** — real(function)',
      '```',
      'a prose line without a number prefix',
      '5\tfunction real() {}',
      '```',
      '',
    ].join('\n');
    const result = await exploring(content).explore('x');
    expect(result.symbols).toEqual([expect.objectContaining({ name: 'real', line: 5 })]);
  });

  it('recovers a blast-radius symbol with line 0 when no definition line exists', async () => {
    const content = [
      '- `Ghost` (src/a.ts:0) — 1 caller',
      '**`src/a.ts`** — real(function)',
      '```',
      '5\tfunction real() {}',
      '```',
      '',
    ].join('\n');
    const result = await exploring(content).explore('x');
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Ghost', file: 'src/a.ts', line: 0 }));
  });

  it('tolerates null and text-less tool content', async () => {
    const cgNull = new CodegraphClient('unused');
    poke(cgNull).client = fakeMcp((name) => (name === 'codegraph_status' ? ok : { content: null }));
    expect((await cgNull.explore('x')).symbols).toEqual([]);

    const cgBare = new CodegraphClient('unused');
    poke(cgBare).client = fakeMcp((name) =>
      name === 'codegraph_status' ? ok : { content: [{ type: 'text' }] });
    expect((await cgBare.explore('x')).symbols).toEqual([]);
  });

  it('warns with a line count when nothing parses at all', async () => {
    const cg = exploring('nothing\nparseable\nhere\n');
    const result = await cg.explore('x');
    expect(result.symbols).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('produced no results'));
  });

  it('reports the missing index (not a format change) when the server stderr said so', async () => {
    const cg = exploring('nothing\nparseable\nhere\n');
    poke(cg).serverStderrTail = ['[CodeGraph MCP] No .codegraph/ at or above /proj: no default project, live sync disabled.'];
    const result = await cg.explore('x');
    expect(result.symbols).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no .codegraph/ index'));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('output format may have changed'));
  });

  it('truncates explore output beyond 100k lines', async () => {
    const cg = exploring('filler line\n'.repeat(100_001));
    const result = await cg.explore('x');
    expect(result.truncated).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('truncating to'));
  });

  it('returns empty impact/search results for empty content', async () => {
    const cg = exploring('');
    expect((await cg.impact('x')).affected).toEqual([]);
    expect((await cg.search('x')).items).toEqual([]);
  });

  it('returns null from getSymbolSignature for empty content', async () => {
    const cg = exploring('');
    expect(await cg.getSymbolSignature('ghost')).toBeNull();
  });
});

/* ── preflight diagnostics (fake binaries on PATH) ── */

describe('preflight diagnostics', () => {
  let tmpDir: string;
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-cgpreflight-'));
    // .npm/ in the path satisfies the allowed-prefix validation.
    binDir = path.join(tmpDir, '.npm', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeBinary(name: string, script: string): string {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, script, { mode: 0o755 });
    return p;
  }

  it('returns an install hint when which resolves to nothing', async () => {
    fakeBinary('which', '#!/bin/sh\nexit 0\n');
    const cg = new CodegraphClient('codegraph');
    await expect(cg.preflight()).resolves.toContain('install from');
  });

  it('rejects a resolution outside the allowed installation prefixes', async () => {
    const evil = path.join(tmpDir, 'evil-codegraph');
    fs.writeFileSync(evil, '#!/bin/sh\n', { mode: 0o755 });
    fakeBinary('which', `#!/bin/sh\necho '${evil}'\n`);
    const cg = new CodegraphClient('codegraph');
    await expect(cg.preflight()).resolves.toContain('unexpected path');
  });

  it("reports a missing --mcp flag with version 'unknown' when the version probe fails", async () => {
    // --version succeeds for the step-1 sanity check but fails when
    // getCodegraphVersion re-probes it, exercising the 'unknown' fallback.
    const state = path.join(tmpDir, 'vstate');
    fakeBinary('codegraph', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  [ -f '${state}' ] && exit 1`,
      `  touch '${state}'`,
      "  echo 'codegraph 1.2.3'",
      '  exit 0',
      'fi',
      'if [ "$1" = "serve" ]; then echo "Usage: serve"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'));
    const cg = new CodegraphClient('codegraph');
    const res = await cg.preflight();
    expect(res).toContain('Codegraph unknown');
    expect(res).toContain('does not show --mcp');
  });

  it("falls back with the tool's version when serve is an unknown command", async () => {
    fakeBinary('codegraph', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codegraph 9.9.9"; exit 0; fi',
      'if [ "$1" = "serve" ]; then echo "error: unknown command" >&2; exit 1; fi',
      'exit 0',
      '',
    ].join('\n'));
    const cg = new CodegraphClient('codegraph');
    const res = await cg.preflight();
    expect(res).toContain('Codegraph 9.9.9');
    expect(res).toContain("does not support 'serve --mcp'");
  });

  it('reports a generic preflight failure for unrecognized serve errors', async () => {
    fakeBinary('codegraph', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codegraph 1.0.0"; exit 0; fi',
      'if [ "$1" = "serve" ]; then echo "boom" >&2; exit 1; fi',
      'exit 0',
      '',
    ].join('\n'));
    const cg = new CodegraphClient('codegraph');
    await expect(cg.preflight()).resolves.toContain('preflight check failed: boom');
  });

  it('caches the version string across preflight calls', async () => {
    // --version succeeds exactly three times: step 1 + getCodegraphVersion on
    // the first preflight, then step 1 again on the second. A fourth call
    // fails — proving the second getCodegraphVersion used the cache.
    const state = path.join(tmpDir, 'vstate');
    fakeBinary('codegraph', [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  n=0',
      `  [ -f '${state}' ] && n=$(cat '${state}')`,
      '  n=$((n + 1))',
      `  echo "$n" > '${state}'`,
      '  [ "$n" -gt 3 ] && exit 1',
      "  echo 'codegraph 1.2.3'",
      '  exit 0',
      'fi',
      'if [ "$1" = "serve" ]; then echo "Usage: serve"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'));
    const cg = new CodegraphClient('codegraph');
    await expect(cg.preflight()).resolves.toContain('Codegraph 1.2.3');
    // Reset only the preflight cache — the version cache must survive.
    poke(cg)._preflightResult = undefined;
    await expect(cg.preflight()).resolves.toContain('Codegraph 1.2.3');
  });
});

/* ── connection timers ── */

describe('connection timers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isAvailable gives up on a hanging liveness check and closes the client', async () => {
    const cg = new CodegraphClient('unused');
    const fake: FakeMcp = {
      callTool: vi.fn().mockReturnValue(new Promise(() => {})), // hangs
      close: vi.fn().mockRejectedValue(new Error('already dead')), // swallow must absorb this
    };
    poke(cg).client = fake;
    poke(cg)._preflightResult = null;

    await expect(cg.isAvailable(50)).resolves.toBe(false);
    expect(fake.close).toHaveBeenCalled();
    expect(poke(cg).client).toBeNull();
  });

  it('abandons a hung liveness retry after the timeout and discards the client', async () => {
    vi.useFakeTimers();
    const cg = new CodegraphClient('definitely-missing-binary');
    let statusCalls = 0;
    const fake: FakeMcp = {
      callTool: vi.fn().mockImplementation(() => {
        statusCalls++;
        if (statusCalls === 1) return Promise.resolve({ isError: true, content: [] });
        return new Promise(() => {}); // the retry hangs
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    poke(cg).client = fake;

    const assertion = expect(cg.connect()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(statusCalls).toBe(2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(poke(cg).client).toBeNull();
  });

  it('times out a hanging tool call', async () => {
    vi.useFakeTimers();
    const cg = new CodegraphClient('unused');
    const fake: FakeMcp = {
      callTool: vi.fn().mockImplementation((params: { name: string }) => {
        if (params.name === 'codegraph_status') return Promise.resolve(ok);
        return new Promise(() => {}); // the tool call hangs
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    poke(cg).client = fake;

    const assertion = expect(cg.explore('x')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
  });
});
