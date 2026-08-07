export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'module';
  file: string;
  line: number;
  /** Folded single-line signature (interior whitespace collapsed). */
  signature?: string;
  /** Original multi-line signature text, when the extractor captured more than one line. */
  raw_signature?: string;
  /** Leading documentation comment (or first-statement docstring) attached to the
   *  symbol, e.g. a JSDoc block for TS/JS. Used to build `inline` doc_sections. */
  docstring?: string;
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
