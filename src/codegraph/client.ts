// src/codegraph/client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CONNECT_TIMEOUT_MS = 5000;


export interface ExploreResult {
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    signature?: string;
  }>;
  files: string[];
}

export interface ImpactResult {
  symbol: string;
  affected: Array<{
    name: string;
    kind: string;
    file: string;
    relation: string;
  }>;
}

export interface SearchResult {
  items: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
  }>;
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
        // Create a shared deferred promise so concurrent callers await
        // one doConnect result instead of recursing into connect().
        this.connectPromise = this.doConnect();
        return this.connectPromise;
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
          const result = await currentClient.callTool(
            { name: 'codegraph_status', arguments: {} },
            undefined,
            { signal: controller.signal },
          );
          clearTimeout(timeout);
          if (!result.isError) return;
        } catch {
          // One retry before discarding the client — transient errors
          // (protocol timeouts, network hiccups) shouldn't force a full reconnect.
          try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), CONNECT_TIMEOUT_MS);
            const result2 = await currentClient.callTool(
              { name: 'codegraph_status', arguments: {} },
              undefined,
              { signal: controller2.signal },
            );
            clearTimeout(timeout2);
            if (!result2.isError) return;
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
    if (/[;&|`$()\n\r\t]/.test(cmd) || cmd.length > 256) {
      throw new Error(`Invalid codegraph command: ${cmd}. Use 'codegraph' or a trusted installation path.`);
    }
    // Reject relative paths (contain path separators but don't start with /)
    if ((cmd.includes('/') || cmd.includes('\\')) && !cmd.startsWith('/')) {
      throw new Error(`Invalid codegraph command: ${cmd}. Relative paths are not allowed. Use an absolute path or a bare binary name.`);
    }

    // Always resolve and validate the binary path, whether it comes from
    // the default 'codegraph' or from user config. Skipping validation
    // for user-configured commands undermines the PATH hijacking defense.
    try {
      const { execFileSync } = await import('node:child_process');
      cmd = execFileSync('which', ['--', cmd], { encoding: 'utf-8' }).trim();
      if (!cmd || cmd.includes('\n')) {
        throw new Error(`${this.command ? this.command : 'codegraph'} not found in PATH`);
      }
      // Resolve symlinks before prefix check to prevent symlink bypass
      const fs = await import('node:fs');
      cmd = fs.realpathSync(cmd);
      // Validate resolved path is in expected installation locations.
      // Use specific known paths rather than broad directory prefixes like
      // /usr/ which would match both /usr/bin and /usr/local/bin, allowing
      // a malicious binary placed in an earlier PATH entry to pass the check.
      const allowedPrefixes = ['/usr/bin/', '/usr/lib/node_modules/.bin/', '/opt/', '/run/current-system/sw/bin/'];
      // Also accept common user-level node_modules bin paths
      if (!allowedPrefixes.some((p) => cmd.startsWith(p)) &&
          !/\/(\.local\/share|\.npm|\.nvm)\//.test(cmd)) {
        throw new Error(`codegraph resolved to unexpected path: ${cmd}`);
      }
    } catch (err: any) {
      throw new Error(`Cannot resolve codegraph binary: ${err.message}`);
    }

    const transport = new StdioClientTransport({
      command: cmd,
      args: ['mcp'],
    });

    const client = new Client(
      { name: 'docrel-codegraph-client', version: '0.1.0' },
      { capabilities: {} },
    );

    try {
      // Store the connect error so we can surface it if the connection
      // fails (not just times out). The pre-attached catch prevents
      // unhandled rejection when Promise.race resolves to the timeout.
      let connectErr: Error | null = null;
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
      throw err;
    }
  }

  async isAvailable(timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch (err) {
      // Log the underlying error for diagnostics, then return false.
      // The empty catch previously swallowed all connection errors,
      // making it impossible to diagnose why codegraph was unavailable.
      console.warn('DocRel: codegraph isAvailable() failed:', err instanceof Error ? err.message : err);
      // Bump the generation so any in-flight doConnect discards its result
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
    await this.connect();
    if (!this.client) {
      throw new Error('Codegraph client is not connected');
    }
    return this.client;
  }

  async explore(query: string, maxFiles = 12): Promise<ExploreResult> {
    const client = await this.ensureConnected();

    const result = await client.callTool({
      name: 'codegraph_explore',
      arguments: { query, maxFiles },
    });

    const content = extractTextContent(result.content);

    return this.parseExploreOutput(content);
  }

  async impact(symbol: string, depth = 2): Promise<ImpactResult> {
    const client = await this.ensureConnected();

    const result = await client.callTool({
      name: 'codegraph_impact',
      arguments: { symbol, depth },
    });

    const content = extractTextContent(result.content);

    return this.parseImpactOutput(symbol, content);
  }

  async search(query: string, kind?: string): Promise<SearchResult> {
    const client = await this.ensureConnected();

    const args: Record<string, unknown> = { query };
    if (kind) args.kind = kind;

    const result = await client.callTool({
      name: 'codegraph_search',
      arguments: args,
    });

    const content = extractTextContent(result.content);

    return this.parseSearchOutput(content);
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

    if (!content) return { symbols: [], files: [] };

    const lines = content.split('\n');
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
        currentLine = parseInt(lineNumMatch[1]);
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
      console.warn(`DocRel: explore parsing produced no results from ${content.length} chars — codegraph output format may have changed. Sample: ${content.slice(0, 200)}`);
    }

    return { symbols, files };
  }

  private parseImpactOutput(symbol: string, content: string): ImpactResult {
    if (!content) return { symbol, affected: [] };

    const affected: ImpactResult['affected'] = [];
    const lines = content.split('\n');

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

    return { symbol, affected };
  }

  private parseSearchOutput(content: string): SearchResult {
    if (!content) return { items: [] };

    const items: SearchResult['items'] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/(\w+)\s*\((\w+)\)\s*in\s+(\S+):(\d+)/);
      if (match) {
        items.push({ name: match[1], kind: match[2], file: match[3], line: parseInt(match[4]) });
      }
    }

    return { items };
  }
}

/** Safely extract text content from an MCP tool result. Validates that
 *  content is an array before mapping, and logs a warning if content is
 *  present but in an unexpected shape. */
function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    if (content) {
      console.warn('DocRel: codegraph returned non-array content type:', typeof content);
    }
    return '';
  }
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}
