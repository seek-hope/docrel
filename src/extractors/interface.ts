export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'module';
  file: string;
  line: number;
  signature?: string;
  language: string;
}

export interface SymbolExtractor {
  readonly name: string;
  /** Discover all symbols in the given directory.
   *  @param since — Unix timestamp (ms). When set, skip files with mtime <= since. */
  extract(dir: string, projectRoot: string, since?: number): Promise<ExtractedSymbol[]>;
  /** Check if this extractor is available. */
  isAvailable(): Promise<boolean>;
}
