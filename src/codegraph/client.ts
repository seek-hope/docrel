// src/codegraph/client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

  constructor(private command?: string) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const transport = new StdioClientTransport({
      command: this.command ?? 'codegraph',
      args: ['mcp'],
    });

    this.client = new Client(
      { name: 'docrel-codegraph-client', version: '0.1.0' },
      { capabilities: {} },
    );

    await this.client.connect(transport);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  async explore(query: string, maxFiles = 12): Promise<ExploreResult> {
    await this.connect();

    const result = await this.client!.callTool({
      name: 'codegraph_explore',
      arguments: { query, maxFiles },
    });

    const content = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return this.parseExploreOutput(content);
  }

  async impact(symbol: string, depth = 2): Promise<ImpactResult> {
    await this.connect();

    const result = await this.client!.callTool({
      name: 'codegraph_impact',
      arguments: { symbol, depth },
    });

    const content = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return this.parseImpactOutput(symbol, content);
  }

  async search(query: string, kind?: string): Promise<SearchResult> {
    await this.connect();

    const args: Record<string, unknown> = { query };
    if (kind) args.kind = kind;

    const result = await this.client!.callTool({
      name: 'codegraph_search',
      arguments: args,
    });

    const content = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return this.parseSearchOutput(content);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
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

    const lines = content.split('\n');
    for (const line of lines) {
      // Detect file headers: "## relative/path/file.ts" or "## File: path/file.ts"
      const fileHeader = line.match(/^##\s+(?:File:\s*)?(\S+\.\w+)/);
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

      // Extract symbol definitions with their kind and name
      const symbolMatch = line.match(
        /(?:function|class|interface|type|const|method|export\s+(?:function|class|interface|type|const))\s+(\w+)/
      );
      if (symbolMatch && currentFile) {
        const kindMatch = line.match(
          /\b(function|class|interface|type|const|method|enum)\b/
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
      const symbolRegex = /(?:function|class|interface|type|const|method)\s+(\w+)/g;
      let match: RegExpExecArray | null;
      while ((match = symbolRegex.exec(content)) !== null) {
        symbols.push({ name: match[1], kind: 'function', file: '', line: 0 });
      }
    }

    return { symbols, files };
  }

  private parseImpactOutput(symbol: string, content: string): ImpactResult {
    const affected: ImpactResult['affected'] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      // Parse lines like "symbol_name (kind) in file.ts:line"
      const match = line.match(/(\w+)\s*\((\w+)\)\s*(?:in\s+)?(\S+):(\d+)/);
      if (match) {
        affected.push({ name: match[1], kind: match[2], file: match[3], relation: 'depends_on' });
      }
    }

    return { symbol, affected };
  }

  private parseSearchOutput(content: string): SearchResult {
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
