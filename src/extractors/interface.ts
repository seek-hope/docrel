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
  /** Discover all symbols in the given directory. */
  extract(dir: string, projectRoot: string): Promise<ExtractedSymbol[]>;
  /** Check if this extractor is available. */
  isAvailable(): Promise<boolean>;
}
