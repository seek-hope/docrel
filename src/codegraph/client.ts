// src/codegraph/client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateCommandSafety } from '../utils/command.js';

const CONNECT_TIMEOUT_MS = 5000;
const TOOL_CALL_TIMEOUT_MS = 300_000; // 5 minutes — large codebases can take time


export interface ExploreResult {
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    signature?: string;
  }>;
  files: string[];
  /** F5: True when the output was truncated. Callers should check this
   *  and warn that some symbols may not have been scanned. */
  truncated?: boolean;
}

export interface ImpactResult {
  symbol: string;
  affected: Array<{
    name: string;
    kind: string;
    file: string;
    relation: string;
  }>;
  truncated?: boolean;
}

export interface SearchResult {
  items: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
  }>;
  truncated?: boolean;
}

export class CodegraphClient {
  private client: Client | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectGeneration = 0;
  private livenessInProgress = false;

  constructor(private command?: string) {}

  async connect(): Promise<void> {
    if (this.client) {
      // Guard the liveness check so only one caller runs it at a time.
      // Without this, two concurrent callers could both detect a dead client,
      // both set this.client = null, and the second caller would read null
      // on the retry path.
      if (this.livenessInProgress) {
        // Another caller is already checking — wait for connectPromise
        if (this.connectPromise) return this.connectPromise;
        // Liveness check is in progress but no connectPromise exists yet.
        // Wait for liveness to finish instead of starting a competing
        // doConnect(). If we start a fresh doConnect() here and the liveness
        // check succeeds (old client is valid), doConnect() would replace
        // the valid client, leaking the old StdioClientTransport process.
        // After liveness completes, re-enter connect() which will either find
        // the client still valid or proceed to the normal connect path below.
        await new Promise<void>(resolve => {
          const poll = () => {
            if (this.livenessInProgress) { setTimeout(poll, 10); return; }
            resolve();
          };
          setTimeout(poll, 10);
        });
        return this.connect();
      }
      this.livenessInProgress = true;
      try {
        // Capture the current client in a local variable so that a concurrent
        // doConnect() installing a new client does not cause us to operate on
        // the wrong client or destroy a freshly installed one.
        const currentClient = this.client;
        // Liveness check: verify the underlying process is still alive
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
          // Wrap in Promise.race to enforce a hard timeout even if the MCP
          // SDK/transport does not respect the AbortSignal.
          let livenessTimer: NodeJS.Timeout | undefined;
          const result = await Promise.race([
            currentClient.callTool(
              { name: 'codegraph_status', arguments: {} },
              undefined,
              { signal: controller.signal },
            ),
            new Promise<never>((_, reject) => {
              livenessTimer = setTimeout(() => reject(new Error('liveness timeout')), CONNECT_TIMEOUT_MS);
            }),
          ]);
          clearTimeout(timeout);
          if (livenessTimer) clearTimeout(livenessTimer);
          if (!result.isError) return;
          // isError is true — codegraph reported an error even though the
          // call succeeded. The client is reachable but unhealthy. Treat as
          // a liveness failure so the catch block handles cleanup and retry.
          throw new Error('codegraph_status reported an error');
        } catch {
          // One retry before discarding the client — transient errors
          // (protocol timeouts, network hiccups) shouldn't force a full reconnect.
          try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), CONNECT_TIMEOUT_MS);
            let livenessTimer2: NodeJS.Timeout | undefined;
            const result2 = await Promise.race([
              currentClient.callTool(
                { name: 'codegraph_status', arguments: {} },
                undefined,
                { signal: controller2.signal },
              ),
              new Promise<never>((_, reject) => {
                livenessTimer2 = setTimeout(() => reject(new Error('liveness timeout')), CONNECT_TIMEOUT_MS);
              }),
            ]);
            clearTimeout(timeout2);
            if (livenessTimer2) clearTimeout(livenessTimer2);
            if (!result2.isError) return;
            // isError is true on retry as well — codegraph is unhealthy.
            throw new Error('codegraph_status reported an error on retry');
          } catch {}
          // Client died — only close and null the field if it still references
          // the same client we tested (a concurrent doConnect may have replaced it).
          try { await currentClient.close(); } catch {}
          if (this.client === currentClient) {
            this.client = null;
          }
        }
      } finally {
        this.livenessInProgress = false;
      }
    }
    // Use nullish-coalescing assignment to avoid the check-then-set race
    // between two concurrent callers. In single-threaded JS, the expression
    // evaluates atomically because doConnect() returns a Promise synchronously
    // before any await yields. Track which caller created the promise so the
    // finally block only nulls out its own promise.
    const promise = this.connectPromise ?? this.doConnect();
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }

  private async doConnect(): Promise<void> {
    // Capture the generation this call belongs to. If a subsequent call
    // increments connectGeneration before this call finishes, we discard
    // the result to avoid installing a stale client.
    const gen = this.connectGeneration;

    // Validate command: reject shell metacharacters and control characters
    // before passing to which/execFileSync. Absolute paths are allowed (they
    // are validated by the which+realpathSync+prefix check pipeline below).
    // Relative paths containing / or \ (e.g. ./binary, ../binary) are rejected.
    let cmd = this.command ?? 'codegraph';
    if (!validateCommandSafety(cmd, 256)) {
      throw new Error(`Invalid codegraph command: ${cmd}. Use 'codegraph' or a trusted installation path.`);
    }
    // Reject relative paths (contain path separators but don't start with /)
    if ((cmd.includes('/') || cmd.includes('\\')) && !cmd.startsWith('/')) {
      throw new Error(`Invalid codegraph command: ${cmd}. Relative paths are not allowed. Use an absolute path or a bare binary name.`);
    }

    // Always resolve and validate the binary path, whether it comes from
    // the default 'codegraph' or from user config. Skipping validation
    // for user-configured commands undermines the PATH hijacking defense.
    let realStat: { ino: number; dev: number } | null = null;
    try {
      const { execFileSync } = await import('node:child_process');
      cmd = execFileSync('which', ['--', cmd], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!cmd || cmd.includes('\n')) {
        throw new Error(`${this.command ? this.command : 'codegraph'} not found in PATH`);
      }
      // Resolve symlinks before prefix check to prevent symlink bypass
      const fs = await import('node:fs');
      cmd = fs.realpathSync(cmd);

      // Capture inode/device for TOCTOU verification before spawn.
      // A local attacker with write access to the directory could swap
      // the binary between realpathSync resolution and the spawn call
      // inside StdioClientTransport. We record the file identity now
      // and re-verify immediately before transport creation.
      try {
        const st = fs.statSync(cmd);
        if (!st.isFile()) {
          throw new Error(`codegraph resolved to non-file: ${cmd}`);
        }
        realStat = { ino: st.ino, dev: st.dev };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error(`codegraph binary not found at ${cmd}`);
        }
        throw new Error(`Cannot stat codegraph binary: ${err.message}`);
      }

      // Validate resolved path is in expected installation locations.
      // Use specific known paths rather than broad directory prefixes like
      // /usr/ which would match both /usr/bin and /usr/local/bin, allowing
      // a malicious binary placed in an earlier PATH entry to pass the check.
      const allowedPrefixes = ['/usr/bin/', '/usr/local/bin/', '/usr/lib/node_modules/.bin/', '/opt/', '/run/current-system/sw/bin/'];
      // Also accept common user-level node_modules bin paths
      if (!allowedPrefixes.some((p) => cmd.startsWith(p)) &&
          !/\/(\.local\/share|\.npm|\.nvm)\//.test(cmd)) {
        throw new Error(`codegraph resolved to unexpected path: ${cmd}`);
      }
    } catch (err: any) {
      throw new Error(`Cannot resolve codegraph binary: ${err.message}`);
    }

    // TOCTOU guard: verify the binary hasn't been swapped since realpathSync.
    // Compare inode and device — if they differ, a local attacker replaced the
    // file between resolution and spawn.
    // NOTE: fs.statSync may return cached metadata from the kernel's buffer
    // cache, especially on NFS or network filesystems. On local ext4/xfs with
    // default mount options, attribute caching windows are short enough that
    // this provides meaningful defense. For stronger guarantees, the binary
    // could be opened and referenced via /proc/self/fd/<n>.
    if (realStat) {
      const fs = await import('node:fs');
      const currentStat = fs.statSync(cmd);
      if (currentStat.ino !== realStat.ino || currentStat.dev !== realStat.dev) {
        throw new Error('codegraph binary was modified after resolution — refusing to spawn');
      }
    }

    const transport = new StdioClientTransport({
      command: cmd,
      args: ['mcp'],
    });

    const client = new Client(
      { name: 'docrelay-codegraph-client', version: '0.1.0' },
      { capabilities: {} },
    );

    // Store the connect error so we can surface it if the connection
    // fails (not just times out). Declared outside try so the catch
    // block can access it when the timeout wins the race.
    let connectErr: Error | null = null;
    try {
      const connectPromise = client.connect(transport).catch((e) => {
        connectErr = e as Error;
      });
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`codegraph connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
        }, CONNECT_TIMEOUT_MS);
      });
      try {
        await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer!);
      }
      // If connect failed (not a timeout), surface the actual error
      if (connectErr) throw connectErr;
      // If a newer generation started while we were connecting, discard
      if (gen !== this.connectGeneration) {
        try { await client.close(); } catch {}
        return;
      }
      this.client = client;
    } catch (err) {
      try { await client.close(); } catch {}
      // If the connect promise resolved with an error (connectErr is set),
      // surface it instead of the timeout error that won the race.
      // On a dual failure (timeout fires just as connect fails), the actual
      // connection error is more useful for diagnosis than the generic timeout.
      if (connectErr) throw connectErr;
      throw err;
    }
  }

  /** Cache preflight result so it only runs once across multiple isAvailable() calls. */
  private _preflightResult: string | null | undefined = undefined;

  /** Cache the version string so preflight doesn't re-query it. */
  private _cachedVersion: string | null = null;

  /** Get codegraph's version string, with caching. */
  private async getCodegraphVersion(cmd: string): Promise<string> {
    if (this._cachedVersion) return this._cachedVersion;
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
      const v = out.match(/(\d+\.\d+\.\d+)/);
      this._cachedVersion = v ? v[1] : out;
      return this._cachedVersion!;
    } catch {
      return 'unknown';
    }
  }

  /** Quick pre-flight check: is codegraph installed and does it support the MCP subcommand?
   *  Runs `codegraph --version` and `codegraph mcp --help` (or equivalent) without actually
   *  connecting. Returns a diagnostic string on failure, null on success. */
  async preflight(): Promise<string | null> {
    if (this._preflightResult !== undefined) return this._preflightResult;
    let cmd = this.command ?? 'codegraph';
    const { execFileSync } = await import('node:child_process');

    // Validate command safety and resolve the binary path with prefix checks,
    // matching the defense-in-depth from doConnect(). Without this, a malicious
    // .docrelay/config.yaml could specify codegraph.command pointing to an
    // arbitrary binary, and preflight() would execute it via execFileSync.

    // 0a. Reject shell metacharacters / control characters / relative paths
    if (!validateCommandSafety(cmd, 256)) {
      return (this._preflightResult = 'Codegraph command rejected — contains unsafe characters');
    }
    if ((cmd.includes('/') || cmd.includes('\\')) && !cmd.startsWith('/')) {
      return (this._preflightResult = 'Codegraph command rejected — relative paths are not allowed');
    }

    // 0b. Resolve the binary via which and validate its real path prefix
    try {
      const whichOut = execFileSync('which', ['--', cmd], { encoding: 'utf-8', timeout: 3000 }).trim();
      if (!whichOut) return (this._preflightResult = `Codegraph binary '${cmd}' not found on PATH — install from https://github.com/colbymchenry/codegraph`);
      const fs = await import('node:fs');
      const realBin = fs.realpathSync(whichOut);
      const allowedPrefixes = ['/usr/bin/', '/usr/local/bin/', '/usr/lib/node_modules/.bin/', '/opt/', '/run/current-system/sw/bin/'];
      if (!allowedPrefixes.some((p) => realBin.startsWith(p)) &&
          !/\/(\.local\/share|\.npm|\.nvm)\//.test(realBin)) {
        return (this._preflightResult = 'Codegraph resolved to unexpected path — rejected for safety');
      }
      // Use the resolved, validated path for subsequent execFileSync calls
      cmd = realBin;
    } catch {
      return (this._preflightResult = `Codegraph binary '${cmd}' not found on PATH — doc-relay will use the built-in regex extractor instead.`);
    }

    // 1. Check if the binary actually works
    try {
      execFileSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    } catch (err: any) {
      const stderr = err.stderr || err.message || '';
      // Sanitize: error may contain the resolved binary path
      return (this._preflightResult = `Codegraph binary failed to run: ${stderr.slice(0, 200)}`);
    }

    // 2. Check if it supports the 'mcp' subcommand
    // Run `codegraph --help`, then look for 'mcp' in the listed commands.
    // We must use --help (not `codegraph mcp --help`) because some codegraph
    // versions redirect unknown subcommands to the main help output instead
    // of returning an error.
    try {
      const helpOut = execFileSync(cmd, ['--help'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      const hasMcp = /\bmcp\b/.test(helpOut) &&
        (/\bCommands:/i.test(helpOut) || /\bmcp\b/i.test(helpOut.split('\n').filter(l => /^\s{2,}/.test(l)).join('\n')));
      if (!hasMcp) {
        const version = await this.getCodegraphVersion(cmd);
        return (this._preflightResult = `Codegraph ${version} is installed but does not support the 'mcp' subcommand — update to the latest version for richer symbol data. Doc-relay will use its built-in regex extractor instead.`);
      }
    } catch (err: any) {
      const stderr = (err.stderr || err.message || '').toString();
      if (stderr.includes('unknown command') || stderr.includes('Unknown command') || stderr.includes('--help')) {
        return (this._preflightResult = 'Codegraph is installed but does not support the \'mcp\' subcommand — update to the latest version for richer symbol data.');
      }
    }

    this._preflightResult = null;
    return null; // All checks passed
  }

  async isAvailable(timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;

    // Run preflight — if codegraph isn't installed, skip the full connect attempt
    // (which would produce confusing "unknown command 'mcp'" noise on stderr).
    try {
      const preflightIssue = await this.preflight();
      if (preflightIssue) {
        console.warn(`DocRelay: ${preflightIssue}`);
        return false;
      }
    } catch {
      // preflight itself failed — skip connect and fall back
      return false;
    }

    try {
      await Promise.race([
        this.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch (err) {
      console.warn('DocRelay: codegraph connection failed — falling back to built-in extractor:', err instanceof Error ? err.message : err);
      this.connectGeneration++;
      if (this.client) {
        this.client.close().catch(() => {});
        this.client = null;
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Ensure the client is connected and usable. Throws if not. */
  private async ensureConnected(): Promise<Client> {
    // F16: Capture the client locally after connect() to avoid a TOCTOU
    // race where a concurrent isAvailable() call sets this.client = null
    // between the await resolving and the null check.
    await this.connect();
    const c = this.client;
    if (!c) {
      throw new Error('Codegraph client is not connected');
    }
    return c;
  }

  /** Wrap an MCP tool call with a timeout. If the codegraph process hangs or
   *  becomes unresponsive after the liveness check passed, this prevents the
   *  caller from blocking indefinitely. */
  private async callToolWithTimeout(params: { name: string; arguments: Record<string, unknown> }): Promise<any> {
    const client = await this.ensureConnected();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        client.callTool(params) as any,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`callTool '${params.name}' timed out after ${TOOL_CALL_TIMEOUT_MS}ms`)), TOOL_CALL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async explore(query: string, maxFiles = 12): Promise<ExploreResult> {
    const result = await this.callToolWithTimeout({
      name: 'codegraph_explore',
      arguments: { query, maxFiles },
    });

    const content = extractTextContent(result.content);

    return this.parseExploreOutput(content);
  }

  async impact(symbol: string, depth = 2): Promise<ImpactResult> {
    const result = await this.callToolWithTimeout({
      name: 'codegraph_impact',
      arguments: { symbol, depth },
    });

    const content = extractTextContent(result.content);

    return this.parseImpactOutput(symbol, content);
  }

  async search(query: string, kind?: string): Promise<SearchResult> {
    const args: Record<string, unknown> = { query };
    if (kind) args.kind = kind;

    const result = await this.callToolWithTimeout({
      name: 'codegraph_search',
      arguments: args,
    });

    const content = extractTextContent(result.content);

    return this.parseSearchOutput(content);
  }

  /** Query codegraph for the current signature of a single symbol.
   *  Uses codegraph_explore with maxFiles=1 for a focused result.
   *  Extracts the definition line (function/class/const/etc.) from the
   *  returned source code blocks. Returns null if no definition found. */
  async getSymbolSignature(symbolName: string, file?: string): Promise<string | null> {
    const query = file ? `${symbolName} in ${file}` : symbolName;
    const result = await this.callToolWithTimeout({
      name: 'codegraph_explore',
      arguments: { query, maxFiles: 1 },
    });

    const content = extractTextContent(result.content);
    if (!content) return null;

    // Scan the raw codegraph output for the definition line of this symbol.
    // The output format is markdown with source code blocks. Look for lines
    // that match known definition patterns for this symbol name.
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const defPattern = new RegExp(
      `(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b|` +
      `(?:async\\s+)?\\b${escaped}\\s*\\(`,
    );

    // F24 (round 9): Use truncateLines to bound line count before split.
    // parseExploreOutput uses MAX_OUTPUT_LINES=100K; apply the same guard
    // here to prevent unbounded array allocation from unexpected codegraph
    // responses (e.g., a very large file with maxFiles=1).
    const MAX_LINES = 100_000;
    const { boundedContent } = truncateLines(content, MAX_LINES, 'getSymbolSignature');
    const lines = boundedContent.split('\n');
    // Walk backwards from the end — the most relevant definition is usually
    // the last match (closest to the symbol's actual definition block).
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (defPattern.test(line)) {
        // Trim leading line-number prefix like "123| " or "  123| "
        const sig = line.replace(/^\s*\d+\s*\|\s*/, '').trim();
        if (sig) return sig;
      }
    }

    return null;
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } finally {
        this.client = null;
      }
    }
  }

  private parseExploreOutput(content: string): ExploreResult {
    // Parse the markdown/code output from codegraph_explore
    // The output groups symbols by file with "## filename" headers.
    // We track the current file context and associate symbols with it.
    const symbols: ExploreResult['symbols'] = [];
    const files: string[] = [];
    let currentFile = '';
    let currentLine = 0;
    let truncated = false;

    if (!content) return { symbols: [], files: [] };

    const MAX_OUTPUT_LINES = 100_000;
    const { boundedContent: bounded, truncated: wasTruncated } = truncateLines(content, MAX_OUTPUT_LINES, 'explore');
    truncated = wasTruncated;
    const lines = bounded.split('\n');
    for (const line of lines) {
      // Detect file headers: "## relative/path/file.ts" or "## File: path/file.ts"
      // Allow extensionless files (Makefile, Dockerfile, .gitignore, etc.)
      const fileHeader = line.match(/^##\s+(?:File:\s*)?(\S+)/);
      if (fileHeader) {
        currentFile = fileHeader[1];
        currentLine = 0;
        if (!files.includes(currentFile)) files.push(currentFile);
        continue;
      }

      // Track line numbers from source code blocks if available
      const lineNumMatch = line.match(/^\s*(\d+)\s*[|\|]\s*/);
      if (lineNumMatch) {
        currentLine = parseInt(lineNumMatch[1], 10);
      }

      // Extract symbol definitions with their kind and name.
      // Matches: async function, export async function, export default function/class, etc.
      // Also supports Python (def), Rust (fn), Go (func), and C (struct).
      const symbolMatch = line.match(
        /(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|const|method|enum|fn|def|func|struct)\s+([\w$]+)/
      );
      if (symbolMatch && currentFile) {
        const kindMatch = line.match(
          /\b(function|class|interface|type|const|method|enum|fn|def|func|struct)\b/
        );
        symbols.push({
          name: symbolMatch[1],
          kind: kindMatch ? kindMatch[1] : 'function',
          file: currentFile,
          line: currentLine,
        });
      }
    }

    // Fallback: if no file sections were found, scan all content for symbols
    if (files.length === 0) {
      const fileRegex = /^## .*?(\S+\.\w+)/gm;
      let match: RegExpExecArray | null;
      while ((match = fileRegex.exec(content)) !== null) {
        if (!files.includes(match[1])) files.push(match[1]);
      }
    }

    // Fallback: if no symbols were associated with files, extract any remaining
    if (symbols.length === 0) {
      const symbolRegex = /(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|const|method|enum|fn|def|func|struct)\s+([\w$]+)/g;
      let match: RegExpExecArray | null;
      while ((match = symbolRegex.exec(content)) !== null) {
        symbols.push({ name: match[1], kind: 'function', file: '', line: 0 });
      }
    }

    // If content was returned but parsing produced no symbols, codegraph may
    // have changed its output format or returned an error message. Log a
    // sample so operators can detect format mismatches.
    if (content && symbols.length === 0 && files.length === 0) {
      // F24 (round 9): Count newlines via a bounded linear scan instead of
      // split('\n') which would allocate a multi-million-element array on
      // unexpected large codegraph responses.
      let linesCount = 1;
      for (let i = 0; i < content.length && i < 10_000_000; i++) {
        if (content[i] === '\n') linesCount++;
      }
      console.warn(`DocRelay: explore parsing produced no results from ${content.length} chars in ${linesCount} lines — codegraph output format may have changed.`);
    }
    // F18: Warn when only one of symbols/files is empty — partial parse
    // may indicate a codegraph output format change.
    if (content && symbols.length === 0 && files.length > 0) {
      console.warn(`DocRelay: explore parsed ${files.length} files but 0 symbols — codegraph output format may have changed.`);
    }
    if (content && files.length === 0 && symbols.length > 0) {
      console.warn(`DocRelay: explore parsed ${symbols.length} symbols but 0 files — codegraph output format may have changed.`);
    }

    return { symbols, files, truncated };
  }

  private parseImpactOutput(symbol: string, content: string): ImpactResult {
    if (!content) return { symbol, affected: [] };

    const MAX_OUTPUT_LINES = 100_000;
    const { boundedContent: bounded, truncated } = truncateLines(content, MAX_OUTPUT_LINES, 'impact');
    const lines = bounded.split('\n');
    const affected: ImpactResult['affected'] = [];

    for (const line of lines) {
      // Parse lines like "symbol_name (kind) in file.ts:line"
      // Also try to capture relation type if codegraph provides it:
      // "symbol_name (kind) [relation_type] in file.ts:line"
      const match = line.match(/(\w+)\s*\((\w+)\)\s*(?:\[(\w+)\]\s*)?(?:in\s+)?(\S+):(\d+)/);
      if (match) {
        const relation = match[3] || 'depends_on';
        affected.push({ name: match[1], kind: match[2], file: match[4], relation });
      }
    }

    return { symbol, affected, truncated };
  }

  private parseSearchOutput(content: string): SearchResult {
    if (!content) return { items: [] };

    const MAX_OUTPUT_LINES = 100_000;
    const { boundedContent: bounded, truncated } = truncateLines(content, MAX_OUTPUT_LINES, 'search');
    const lines = bounded.split('\n');
    const items: SearchResult['items'] = [];

    for (const line of lines) {
      const match = line.match(/(\w+)\s*\((\w+)\)\s*in\s+(\S+):(\d+)/);
      if (match) {
        items.push({ name: match[1], kind: match[2], file: match[3], line: parseInt(match[4], 10) });
      }
    }

    return { items, truncated };
  }
}

/** Truncate a string to at most `maxLines` lines, counting newlines in a
 *  single pass before splitting. Returns the bounded content and whether
 *  truncation occurred. Avoids the O(n) array allocation of split('\n')
 *  on pathologically long codegraph responses (millions of newlines). */
function truncateLines(content: string, maxLines: number, label: string): { boundedContent: string; truncated: boolean } {
  let lineCount = 0;
  for (let i = 0; i < content.length && lineCount <= maxLines; i++) {
    if (content[i] === '\n') lineCount++;
  }
  // lineCount is the number of newlines — a string with N newlines has
  // at most N+1 lines (fewer if it ends with a newline). We want at most
  // maxLines lines, so reject when lineCount >= maxLines.
  if (lineCount < maxLines) return { boundedContent: content, truncated: false };

  console.warn(`DocRelay: ${label} output has ${lineCount} lines — truncating to ${maxLines}`);
  let nlCount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      nlCount++;
      if (nlCount >= maxLines) {
        return { boundedContent: content.slice(0, i), truncated: true };
      }
    }
  }
  return { boundedContent: content, truncated: true };
}

/** Safely extract text content from an MCP tool result. Validates that
 *  content is an array before mapping, and logs a warning if content is
 *  present but in an unexpected shape. */
function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    if (content) {
      console.warn('DocRelay: codegraph returned non-array content type:', typeof content);
    }
    return '';
  }
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}
